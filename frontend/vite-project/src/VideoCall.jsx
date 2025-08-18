import React, { useEffect, useRef, useState, useCallback } from "react";
import SimplePeer from "simple-peer";
import './VideoCall.css';

const VideoCall = ({ socket, roomId, userName, joined }) => {
  const [peers, setPeers] = useState([]); // [{ peerId, peer, stream, userName, cameraOn, micOn }]
  const [myStream, setMyStream] = useState(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: 20, y: 20 });
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef();
  const [micVolume, setMicVolume] = useState(0); // 0 to 1
  const [mediaError, setMediaError] = useState(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const peerConnectionsRef = useRef({});

  // Helper: update peer state
  // const updatePeerState = (peerId, updates) => {
  //   setPeers((prev) => prev.map(p => p.peerId === peerId ? { ...p, ...updates } : p));
  // };

  // Get media stream with proper error handling
  const getMedia = useCallback(async (videoEnabled = cameraOn, audioEnabled = micOn) => {
    try {
      // Stop existing tracks before getting new stream
      if (myStream) {
        myStream.getTracks().forEach(track => track.stop());
      }
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoEnabled,
        audio: audioEnabled,
      });
      setMyStream(stream);
      return stream;
    } catch (err) {
      console.error('Error accessing media devices:', err);
      setMyStream(null);
      return null;
    }
  }, [cameraOn, micOn, myStream]);

  // Toggle camera with proper stream management
  const toggleCamera = async () => {
    const newCameraState = !cameraOn;
    setCameraOn(newCameraState);
    
    // Notify backend of camera toggle
    socket.emit("toggle-camera");
    
    // Update stream with new camera state
    if (myStream) {
      const videoTrack = myStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = newCameraState;
      }
    }
  };

  // Toggle microphone with improved state management
  const toggleMic = async () => {
    const newMicState = !micOn;
    
    try {
      // Notify backend of microphone toggle
      socket.emit("toggle-microphone");
      
      // Update local state
      setMicOn(newMicState);
      setMediaError(null);
      
      // Handle stream track enabling/disabling
      if (myStream) {
        const audioTrack = myStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = newMicState;
        } else if (newMicState) {
          // If no audio track exists, request microphone permission
          try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const newAudioTrack = audioStream.getAudioTracks()[0];
            
            if (newAudioTrack) {
              myStream.addTrack(newAudioTrack);
              newAudioTrack.enabled = true;
              
              // Update all peer connections with new audio track
              Object.values(peerConnectionsRef.current).forEach(peer => {
                if (peer && peer._pc) {
                  peer._pc.addTrack(newAudioTrack, myStream);
                }
              });
              
              setMyStream(myStream);
            }
          } catch (err) {
            console.error('Error accessing microphone:', err);
            setMediaError('Microphone access denied or unavailable');
            setMicOn(false);
          }
        }
      }
    } catch (err) {
      console.error('Error toggling microphone:', err);
      setMediaError('Failed to toggle microphone');
      setMicOn(!newMicState); // Revert state on error
    }
  };

  // Draggable logic
  const onMouseDown = (e) => {
    setDragging(true);
    setOffset({ x: e.clientX - panelPos.x, y: e.clientY - panelPos.y });
  };
  const onMouseMove = useCallback(
    (e) => {
      if (dragging) {
        setPanelPos({ x: e.clientX - offset.x, y: e.clientY - offset.y });
      }
    },
    [dragging, offset]
  );

  useEffect(() => {
    window.addEventListener("mousemove", onMouseMove);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [onMouseMove]);
  const onMouseUp = () => setDragging(false);

  // Setup/cleanup event listeners for dragging
  useEffect(() => {
    if (dragging) {
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    } else {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, onMouseMove]);

  // Join/leave call logic
  useEffect(() => {
    if (!joined || !roomId || !userName) return;
    let cleanup = false;
    let localStream = null;
    let myPeerId = socket.id;
    
    setIsInitializing(true);
    setMediaError(null);

    // Join call room
    socket.emit("join-call", { roomId, userName });

    // Get initial media stream (always request both audio and video)
    navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    }).then((stream) => {
      if (cleanup) return;
      localStream = stream;
      setMyStream(stream);
      setIsInitializing(false);
      
      // Set initial track states
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      
      if (videoTrack) videoTrack.enabled = cameraOn;
      if (audioTrack) audioTrack.enabled = micOn;
    }).catch((err) => {
      console.error('Error accessing media devices:', err);
      setMediaError('Camera access denied');
      
      // Try audio-only if video fails
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        if (cleanup) return;
        localStream = stream;
        setMyStream(stream);
        setIsInitializing(false);
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = micOn;
      }).catch((audioErr) => {
        console.error('Error accessing audio device:', audioErr);
        setMediaError('Microphone access denied or unavailable');
        setMyStream(null);
        setIsInitializing(false);
      });
    });

    // Handle new user joining
    socket.on("user-joined-call", ({ userName: remoteName, socketId }) => {
      if (socketId === myPeerId) return;
      const peer = new SimplePeer({
        initiator: true,
        trickle: false,
        stream: localStream,
      });
      peer.on("signal", (signal) => {
        socket.emit("signal", { roomId, signal, to: socketId });
      });
      peer.on("stream", (stream) => {
        setPeers((prev) => [
          ...prev,
          {
            peerId: socketId,
            peer,
            stream,
            userName: remoteName,
            cameraOn: true,
            micOn: true,
          },
        ]);
      });
      peerConnectionsRef.current[socketId] = peer;
    });

    // Handle receiving signal
    socket.on("signal", ({ signal, from }) => {
      let peer = peerConnectionsRef.current[from];
      if (!peer) {
        peer = new SimplePeer({
          initiator: false,
          trickle: false,
          stream: localStream,
        });
        peerConnectionsRef.current[from] = peer;
        peer.on("signal", (signal) => {
          socket.emit("signal", { roomId, signal, to: from });
        });
        peer.on("stream", (stream) => {
          setPeers((prev) => [
            ...prev,
            {
              peerId: from,
              peer,
              stream,
              userName: "",
              cameraOn: true,
              micOn: true,
            },
          ]);
        });
      }
      peer.signal(signal);
    });

    // Handle user leaving
    socket.on("user-left-call", ({ socketId }) => {
      setPeers((prev) => prev.filter((p) => p.peerId !== socketId));
      if (peerConnectionsRef.current[socketId]) {
        peerConnectionsRef.current[socketId].destroy();
        delete peerConnectionsRef.current[socketId];
      }
    });

    // Cleanup on unmount
    return () => {
      cleanup = true;
      socket.emit("leave-call", { roomId });
      Object.values(peerConnectionsRef.current).forEach((peer) => peer.destroy());
      peerConnectionsRef.current = {};
      setPeers([]);
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
    };
    // eslint-disable-next-line
  }, [joined, roomId, userName]);

  // Handle microphone and camera state changes without recreating stream
  useEffect(() => {
    if (myStream) {
      const videoTrack = myStream.getVideoTracks()[0];
      const audioTrack = myStream.getAudioTracks()[0];
      
      if (videoTrack) {
        videoTrack.enabled = cameraOn;
      }
      if (audioTrack) {
        audioTrack.enabled = micOn;
      }
    }
  }, [cameraOn, micOn, myStream]);

  // Handle remote microphone toggle events
  useEffect(() => {
    const handleMicrophoneToggled = ({ socketId, micOn: remoteMicOn }) => {
      setPeers(prev => prev.map(peer => 
        peer.peerId === socketId 
          ? { ...peer, micOn: remoteMicOn }
          : peer
      ));
    };

    const handleCameraToggled = ({ socketId, cameraOn: remoteCameraOn }) => {
      setPeers(prev => prev.map(peer => 
        peer.peerId === socketId 
          ? { ...peer, cameraOn: remoteCameraOn }
          : peer
      ));
    };

    socket.on("microphone-toggled", handleMicrophoneToggled);
    socket.on("camera-toggled", handleCameraToggled);

    return () => {
      socket.off("microphone-toggled", handleMicrophoneToggled);
      socket.off("camera-toggled", handleCameraToggled);
    };
  }, [socket]);

  // Audio analysis for local mic with improved error handling
  useEffect(() => {
    let audioContext, analyser, dataArray, source, animationId;
    
    if (micOn && myStream) {
      try {
        const audioTrack = myStream.getAudioTracks()[0];
        if (audioTrack && audioTrack.enabled) {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
          analyser = audioContext.createAnalyser();
          source = audioContext.createMediaStreamSource(myStream);
          source.connect(analyser);
          analyser.fftSize = 256;
          dataArray = new Uint8Array(analyser.frequencyBinCount);
          
          const tick = () => {
            if (!micOn || !audioTrack.enabled) {
              setMicVolume(0);
              return;
            }
            
            try {
              analyser.getByteTimeDomainData(dataArray);
              // Calculate RMS (root mean square) for volume
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) {
                let val = (dataArray[i] - 128) / 128;
                sum += val * val;
              }
              setMicVolume(Math.sqrt(sum / dataArray.length));
              animationId = requestAnimationFrame(tick);
            } catch (err) {
              console.error('Error analyzing audio:', err);
              setMicVolume(0);
            }
          };
          tick();
        } else {
          setMicVolume(0);
        }
      } catch (err) {
        console.error('Error setting up audio analysis:', err);
        setMicVolume(0);
      }
    } else {
      setMicVolume(0);
    }
    
    return () => {
      if (animationId) cancelAnimationFrame(animationId);
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(err => console.error('Error closing audio context:', err));
      }
    };
  }, [micOn, myStream]);

  // UI for each video
  const renderVideo = (stream, label, isMe, camOn, micOn) => (
    <div className="video-tile">
      {camOn && stream ? (
        <video
          ref={(ref) => {
            if (ref) {
              ref.srcObject = stream;
              ref.play();
            }
          }}
          muted={isMe}
          autoPlay
        />
      ) : (
        <div className="video-placeholder">{label[0] || "?"}</div>
      )}
      <div className="video-label">
        {label} {camOn ? "📷" : "🚫"}{" "}
        {micOn ? (
          <>
            🎤
            {isMe && (
              <span className="mic-volume-bar">
                <span
                  className="mic-volume-fill"
                  style={{
                    width: `${Math.min(100, Math.round(micVolume * 100))}%`,
                  }}
                />
              </span>
            )}
          </>
        ) : (
          "🔇"
        )}
      </div>
    </div>
  );

  return (
    <div
      className="video-call-panel"
      ref={panelRef}
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      <div className="video-call-header" onMouseDown={onMouseDown}>
        Video Call
        {isInitializing && <span className="initializing-indicator">Initializing...</span>}
      </div>
      {mediaError && (
        <div className="media-error">
          ⚠️ {mediaError}
        </div>
      )}
      <div className="video-call-controls">
        <button 
          onClick={toggleCamera}
          disabled={isInitializing}
          className={cameraOn ? "active" : ""}
        >
          {cameraOn ? "📷 Camera On" : "📷 Camera Off"}
        </button>
        <button 
          onClick={toggleMic}
          disabled={isInitializing}
          className={micOn ? "active" : ""}
        >
          {micOn ? "🎤 Unmute" : "🔇 Mute"}
        </button>
      </div>
      <div className="video-call-videos">
        {renderVideo(myStream, userName || "Me", true, cameraOn, micOn)}
        {peers.map((p) =>
          renderVideo(
            p.stream,
            p.userName || p.peerId.slice(0, 6),
            false,
            p.cameraOn,
            p.micOn
          )
        )}
      </div>
    </div>
  );
};

export default VideoCall;