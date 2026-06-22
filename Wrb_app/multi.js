(function () {
  let socket;

  try {
    socket = typeof io === "function" ? io() : null;
  } catch (error) {
    console.error("Socket.IO client not available:", error);
    socket = null;
  }

  if (!socket) {
    socket = {
      id: "local-fallback",
      on: () => {},
      emit: () => {}
    };
  }

  const roomInput = document.getElementById("roomInput");
  const joinRoomBtn = document.getElementById("joinRoomBtn");
  const leaveRoomBtn = document.getElementById("leaveRoomBtn");
  const remoteGrid = document.getElementById("remoteVideos");

  const peers = {};
  const remoteTiles = {};
  let joinedRoom = "";

  const defaultRoom = (window.location.hash || "").replace(/^#/, "").trim();
  if (roomInput && defaultRoom) {
    roomInput.value = defaultRoom;
  }

  function updateConnection(text) {
    if (typeof window.updateConnectionPill === "function") {
      window.updateConnectionPill(text);
    }
  }

  async function ensureLocalMedia() {
    if (typeof window.startCamera !== "function") {
      throw new Error("Camera controls are unavailable.");
    }

    await window.startCamera();

    if (typeof window.getLocalStream !== "function") {
      throw new Error("Local stream accessor is unavailable.");
    }

    const stream = window.getLocalStream();
    if (!stream) {
      throw new Error("Local camera stream is not ready.");
    }

    return stream;
  }

  function setJoinedRoom(room) {
    joinedRoom = room;
    updateConnection(room ? `In room: ${room}` : "Not in a room");
  }

  function createRemoteTile(sid) {
    if (!remoteGrid) {
      return null;
    }

    let tile = remoteTiles[sid];
    if (tile) {
      return tile;
    }

    tile = document.createElement("article");
    tile.className = "remote-tile";
    tile.dataset.remoteSid = sid;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;

    const meta = document.createElement("div");
    meta.className = "participant-meta";

    const nameBlock = document.createElement("div");
    const name = document.createElement("div");
    name.className = "participant-name";
    name.textContent = `Guest ${sid.slice(-4)}`;
    const state = document.createElement("div");
    state.className = "participant-state";
    state.textContent = "Connecting";
    nameBlock.appendChild(name);
    nameBlock.appendChild(state);

    meta.appendChild(nameBlock);

    tile.appendChild(video);
    tile.appendChild(meta);
    remoteGrid.appendChild(tile);

    remoteTiles[sid] = tile;
    return tile;
  }

  function removeRemoteTile(sid) {
    const tile = remoteTiles[sid];
    if (tile && tile.parentNode) {
      tile.parentNode.removeChild(tile);
    }

    delete remoteTiles[sid];
  }

  function updateRemoteTileState(sid, text) {
    const tile = remoteTiles[sid];
    if (!tile) {
      return;
    }

    const state = tile.querySelector(".participant-state");
    if (state) {
      state.textContent = text;
    }
  }

  function attachRemoteStream(sid, stream) {
    const tile = createRemoteTile(sid);
    if (!tile) {
      return;
    }

    const video = tile.querySelector("video");
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    updateRemoteTileState(sid, "Connected");
  }

  function createPeerConnection(sid) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    const stream = typeof window.getLocalStream === "function" ? window.getLocalStream() : null;
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("signal", {
          target: sid,
          signal: { type: "ice", candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      attachRemoteStream(sid, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        updateRemoteTileState(sid, "Connected");
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        updateRemoteTileState(sid, pc.connectionState);
      } else if (pc.connectionState === "connecting") {
        updateRemoteTileState(sid, "Connecting");
      }
    };

    return pc;
  }

  async function joinRoom(room) {
    const nextRoom = (room || "").trim();
    if (!nextRoom) {
      return;
    }

    if (joinedRoom && joinedRoom === nextRoom) {
      return;
    }

    await ensureLocalMedia();

    if (joinedRoom && joinedRoom !== nextRoom) {
      await leaveRoom(joinedRoom);
    }

    joinedRoom = nextRoom;
    if (roomInput) {
      roomInput.value = nextRoom;
    }

    if (window.location.hash !== `#${nextRoom}`) {
      window.location.hash = nextRoom;
    }

    socket.emit("join", { room: nextRoom });
    setJoinedRoom(nextRoom);
  }

  async function leaveRoom(room) {
    const targetRoom = (room || joinedRoom || "").trim();

    if (targetRoom) {
      socket.emit("leave", { room: targetRoom });
    }

    Object.keys(peers).forEach((sid) => {
      try {
        peers[sid].close();
      } catch (error) {
        // ignore close failures
      }
      delete peers[sid];
    });

    Object.keys(remoteTiles).forEach(removeRemoteTile);

    joinedRoom = "";
    setJoinedRoom("");
  }

  socket.on("connect", () => {
    if (joinedRoom) {
      updateConnection(`In room: ${joinedRoom}`);
    }
  });

  socket.on("new-peer", async (data) => {
    const sid = data.sid;

    if (sid === socket.id) {
      return;
    }

    const pc = createPeerConnection(sid);
    peers[sid] = pc;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", {
        target: sid,
        signal: { type: "offer", sdp: pc.localDescription }
      });
    } catch (error) {
      console.error("Failed to create offer for peer:", error);
    }
  });

  socket.on("signal", async (data) => {
    const source = data.source;
    const signal = data.signal;

    if (!source || source === socket.id) {
      return;
    }

    let pc = peers[source];
    if (!pc) {
      pc = createPeerConnection(source);
      peers[source] = pc;
    }

    try {
      if (signal.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", {
          target: source,
          signal: { type: "answer", sdp: pc.localDescription }
        });
      } else if (signal.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      } else if (signal.type === "ice" && signal.candidate) {
        await pc.addIceCandidate(signal.candidate);
      }
    } catch (error) {
      console.warn("WebRTC signal handling failed:", error);
    }
  });

  socket.on("peer-left", (data) => {
    const sid = data.sid;

    if (peers[sid]) {
      try {
        peers[sid].close();
      } catch (error) {
        // ignore close failures
      }
      delete peers[sid];
    }

    removeRemoteTile(sid);
  });

  socket.on("disconnect", () => {
    Object.keys(peers).forEach((sid) => {
      try {
        peers[sid].close();
      } catch (error) {
        // ignore close failures
      }
      delete peers[sid];
    });

    Object.keys(remoteTiles).forEach(removeRemoteTile);
    setJoinedRoom("");
  });

  if (joinRoomBtn) {
    joinRoomBtn.addEventListener("click", async () => {
      const room = roomInput ? roomInput.value : "";
      try {
        await joinRoom(room);
      } catch (error) {
        console.error("Failed to join room:", error);
        updateConnection("Could not join the room");
      }
    });
  }

  if (leaveRoomBtn) {
    leaveRoomBtn.addEventListener("click", async () => {
      try {
        await leaveRoom();
      } catch (error) {
        console.error("Failed to leave room:", error);
      }
    });
  }

  if (roomInput) {
    roomInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        try {
          await joinRoom(roomInput.value);
        } catch (error) {
          console.error("Failed to join room:", error);
          updateConnection("Could not join the room");
        }
      }
    });
  }

  if (defaultRoom && joinRoomBtn) {
    window.setTimeout(() => {
      joinRoom(defaultRoom).catch((error) => {
        console.error("Auto-join failed:", error);
      });
    }, 0);
  }

  window.joinRoom = joinRoom;
  window.leaveRoom = leaveRoom;
})();
