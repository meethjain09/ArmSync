import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ShieldAlert,
  Radio,
  Video,
  VideoOff,
  Cpu,
  Wifi,
  WifiOff,
  Sliders,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Play,
  Layers,
  Eye,
  Settings2,
  RefreshCw,
  Box,
  Circle,
  Triangle,
  Activity,
  Maximize2,
  Lock,
  Unlock,
  Crosshair
} from 'lucide-react';

// Operating Modes
type OperatingMode = '1A' | '1B' | '1C';

interface JointAngles {
  base: number;
  shoulder: number;
  elbow: number;
  gripper: number; // 30 = Open, 135 = Closed
}

interface SortLogItem {
  id: string;
  timestamp: string;
  shape: 'Cube' | 'Sphere' | 'Pyramid';
  confidence: number;
  destinationBin: string;
  status: 'Sorted' | 'In Progress' | 'Detected';
}

export default function App() {
  // Connection & Hardware Configuration
  const [esp32Ip, setEsp32Ip] = useState<string>(() => {
    return localStorage.getItem('roboarm_esp32_ip') || '192.168.1.100';
  });
  const [backendWsUrl, setBackendWsUrl] = useState<string>(() => {
    return localStorage.getItem('roboarm_backend_ws') || 'ws://localhost:8000/ws';
  });
  const [showConfig, setShowConfig] = useState(false);

  // Active Operating Mode
  const [activeMode, setActiveMode] = useState<OperatingMode>('1A');

  // Safety & E-Stop
  const [isEStopped, setIsEStopped] = useState<boolean>(false);
  const [eStopReason, setEStopReason] = useState<string>('');

  // WebSocket State
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [esp32Connected, setEsp32Connected] = useState<boolean>(false);
  const [esp32Status, setEsp32Status] = useState<string>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  // Joint Angles (Tab 1A)
  const [joints, setJoints] = useState<JointAngles>({
    base: 90,
    shoulder: 90,
    elbow: 90,
    gripper: 30, // Default: open
  });
  const lastSentJoints = useRef<JointAngles>({ ...joints });
  const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Video Stream (Tab 1A & 1C)
  const [videoLoaded, setVideoLoaded] = useState<boolean>(false);
  const [videoError, setVideoError] = useState<boolean>(false);
  const [streamKey, setStreamKey] = useState<number>(Date.now());
  const [showCrosshairs, setShowCrosshairs] = useState<boolean>(true);

  // Tier 1B (Sense & Place) State
  const [distanceCm, setDistanceCm] = useState<number | null>(null);
  const [isExecutingSequence, setIsExecutingSequence] = useState<boolean>(false);
  const [currentSequenceStep, setCurrentSequenceStep] = useState<number>(0);
  const [sequenceStepName, setSequenceStepName] = useState<string>('');
  const [pickCount, setPickCount] = useState<number>(() => {
    const saved = localStorage.getItem('roboarm_pick_count');
    return saved ? parseInt(saved, 10) : 0;
  });

  // Tier 1C (Vision Sorting) State
  const [detectedShapes, setDetectedShapes] = useState({
    cube: { detected: true, confidence: 96.4, count: 14 },
    sphere: { detected: true, confidence: 91.2, count: 9 },
    pyramid: { detected: false, confidence: 88.5, count: 5 },
  });
  const [sortLogs, setSortLogs] = useState<SortLogItem[]>([
    {
      id: 'log-1',
      timestamp: '13:40:12',
      shape: 'Cube',
      confidence: 97.2,
      destinationBin: 'Bin A (Cyan)',
      status: 'Sorted',
    },
    {
      id: 'log-2',
      timestamp: '13:38:50',
      shape: 'Sphere',
      confidence: 93.8,
      destinationBin: 'Bin B (Indigo)',
      status: 'Sorted',
    },
    {
      id: 'log-3',
      timestamp: '13:37:15',
      shape: 'Pyramid',
      confidence: 89.1,
      destinationBin: 'Bin C (Amber)',
      status: 'Sorted',
    },
  ]);
  const [aiOverlayEnabled, setAiOverlayEnabled] = useState<boolean>(true);

  // Save IP to localStorage
  const handleSaveIp = (ip: string) => {
    setEsp32Ip(ip);
    localStorage.setItem('roboarm_esp32_ip', ip);
    setStreamKey(Date.now());
  };

  const handleSaveBackendWs = (url: string) => {
    setBackendWsUrl(url);
    localStorage.setItem('roboarm_backend_ws', url);
  };

  // ---------------------------------------------------------------------------
  // WebSocket Bridge Connection
  // ---------------------------------------------------------------------------
  const sendWebSocketMessage = useCallback((payload: Record<string, any>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      const socket = new WebSocket(backendWsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setWsConnected(true);
        console.log('[WS] Connected to FastAPI Brain:', backendWsUrl);
      };

      socket.onclose = () => {
        setWsConnected(false);
        setEsp32Connected(false);
        // Auto-reconnect after 2.5 seconds
        setTimeout(connectWebSocket, 2500);
      };

      socket.onerror = (err) => {
        console.warn('[WS] Socket error:', err);
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Handle initial state snapshot
          if (data.type === 'INITIAL_STATE') {
            if (data.active_mode) setActiveMode(data.active_mode as OperatingMode);
            if (data.esp32_connected !== undefined) setEsp32Connected(data.esp32_connected);
            if (data.esp32_status) setEsp32Status(data.esp32_status);
            if (data.distance_cm !== undefined) setDistanceCm(data.distance_cm);
            if (data.is_executing_sequence !== undefined) {
              setIsExecutingSequence(data.is_executing_sequence);
            }
          }

          // Handle telemetry updates
          if (data.type === 'TELEMETRY' && data.esp32) {
            setEsp32Connected(true);
            if (data.esp32.distance_cm !== undefined && data.esp32.distance_cm !== null) {
              setDistanceCm(data.esp32.distance_cm);
            }
            if (data.esp32.status) {
              setEsp32Status(data.esp32.status);
              if (data.esp32.status === 'stopped') {
                setIsEStopped(true);
              }
            }
            if (data.is_executing_sequence !== undefined) {
              setIsExecutingSequence(data.is_executing_sequence);
            }
          }

          // Sequence Lifecycle Events (Tier 1B)
          if (data.event === 'SEQUENCE_STARTED') {
            setIsExecutingSequence(true);
            setCurrentSequenceStep(1);
            setSequenceStepName('Pre-Grasp Approach');
          } else if (data.event === 'SEQUENCE_STEP') {
            setCurrentSequenceStep(data.step_index || 1);
            setSequenceStepName(data.step_name || '');
          } else if (data.event === 'SEQUENCE_COMPLETED') {
            setIsExecutingSequence(false);
            setCurrentSequenceStep(0);
            setSequenceStepName('Idle / Ready');
            setPickCount((prev) => {
              const updated = prev + 1;
              localStorage.setItem('roboarm_pick_count', updated.toString());
              return updated;
            });
          }

          // Emergency Stop alert
          if (data.type === 'ESTOP_TRIGGERED') {
            setIsEStopped(true);
            setEStopReason('Hardware / Software E-Stop Triggered');
          }

          // External Mode Switch
          if (data.type === 'MODE_CHANGE' && data.active_mode) {
            setActiveMode(data.active_mode as OperatingMode);
          }
        } catch (e) {
          console.error('[WS Parse Error]', e);
        }
      };
    } catch (e) {
      console.error('[WS Setup Error]', e);
    }
  }, [backendWsUrl]);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connectWebSocket]);

  // ---------------------------------------------------------------------------
  // Global Emergency Stop (E-Stop)
  // ---------------------------------------------------------------------------
  const handleTriggerEStop = () => {
    setIsEStopped(true);
    setEStopReason('Operator Emergency Stop Pressed');
    sendWebSocketMessage({ command: 'STOP' });
  };

  const handleClearEStop = () => {
    setIsEStopped(false);
    setEStopReason('');
    // Resend current angles to clear halt latch
    sendWebSocketMessage({
      command: 'MOVE',
      base: joints.base,
      shoulder: joints.shoulder,
      elbow: joints.elbow,
      gripper: joints.gripper,
    });
  };

  // ---------------------------------------------------------------------------
  // Safe Mode Switching Protocol
  // 1. Send {"command": "STOP"} to freeze current arm kinematics
  // 2. Send {"command": "SET_MODE", "mode": "<MODE_ID>"}
  // ---------------------------------------------------------------------------
  const handleSwitchMode = (targetMode: OperatingMode) => {
    if (activeMode === targetMode) return;

    // Send safety STOP first
    sendWebSocketMessage({ command: 'STOP' });

    // Brief safety interlock then switch mode
    setTimeout(() => {
      sendWebSocketMessage({ command: 'SET_MODE', mode: targetMode });
      setActiveMode(targetMode);
    }, 50);
  };

  // ---------------------------------------------------------------------------
  // Throttled Manual Servo Dispatches (Tab 1A)
  // ---------------------------------------------------------------------------
  const dispatchJoints = useCallback(
    (newJoints: JointAngles) => {
      if (isEStopped) return;

      lastSentJoints.current = newJoints;

      if (!throttleTimeoutRef.current) {
        throttleTimeoutRef.current = setTimeout(() => {
          sendWebSocketMessage({
            command: 'MOVE',
            base: lastSentJoints.current.base,
            shoulder: lastSentJoints.current.shoulder,
            elbow: lastSentJoints.current.elbow,
            gripper: lastSentJoints.current.gripper,
          });
          throttleTimeoutRef.current = null;
        }, 50); // 20Hz update rate
      }
    },
    [isEStopped, sendWebSocketMessage]
  );

  const handleJointChange = (joint: keyof JointAngles, value: number) => {
    const updated = { ...joints, [joint]: value };
    setJoints(updated);
    if (activeMode === '1A') {
      dispatchJoints(updated);
    }
  };

  const toggleGripper = () => {
    const nextAngle = joints.gripper === 30 ? 135 : 30;
    handleJointChange('gripper', nextAngle);
  };

  const applyPosePreset = (preset: { base: number; shoulder: number; elbow: number; gripper: number }) => {
    setJoints(preset);
    if (activeMode === '1A') {
      dispatchJoints(preset);
    }
  };

  // Video URL generator
  const videoStreamUrl = `http://${esp32Ip}:81/stream?key=${streamKey}`;

  // ---------------------------------------------------------------------------
  // Simulation Helpers for Hackathon Testing / Demo
  // ---------------------------------------------------------------------------
  const triggerSimulatedPickAndPlace = () => {
    if (isExecutingSequence) return;
    setIsExecutingSequence(true);
    setCurrentSequenceStep(1);
    setSequenceStepName('Pre-Grasp Approach');

    const steps = [
      { step: 1, name: 'Pre-Grasp Approach', delay: 1200 },
      { step: 2, name: 'Grip Target (Closed)', delay: 800 },
      { step: 3, name: 'Vertical Clearance Lift', delay: 1000 },
      { step: 4, name: 'Azimuth Swing to Bin', delay: 1400 },
      { step: 5, name: 'Descend to Drop Tray', delay: 1000 },
      { step: 6, name: 'Release Gripper', delay: 800 },
      { step: 7, name: 'Return to Home Pose', delay: 1200 },
    ];

    let accumulatedTime = 0;
    steps.forEach((s, idx) => {
      accumulatedTime += s.delay;
      setTimeout(() => {
        if (idx === steps.length - 1) {
          setIsExecutingSequence(false);
          setCurrentSequenceStep(0);
          setSequenceStepName('Idle / Ready');
          setPickCount((prev) => {
            const next = prev + 1;
            localStorage.setItem('roboarm_pick_count', next.toString());
            return next;
          });
        } else {
          setCurrentSequenceStep(s.step + 1);
          setSequenceStepName(steps[idx + 1].name);
        }
      }, accumulatedTime);
    });
  };

  const addSimulatedVisionSort = (shape: 'Cube' | 'Sphere' | 'Pyramid') => {
    const binMap = {
      Cube: 'Bin A (Cyan)',
      Sphere: 'Bin B (Indigo)',
      Pyramid: 'Bin C (Amber)',
    };
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const newLog: SortLogItem = {
      id: `sort-${Date.now()}`,
      timestamp: timeStr,
      shape,
      confidence: parseFloat((88 + Math.random() * 11).toFixed(1)),
      destinationBin: binMap[shape],
      status: 'Sorted',
    };
    setSortLogs((prev) => [newLog, ...prev.slice(0, 19)]);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-rose-500 selection:text-white">
      {/* =================================================================== */}
      {/* PERSISTENT HEADER & GLOBAL E-STOP PINNED AT TOP                     */}
      {/* =================================================================== */}
      <header className="sticky top-0 z-50 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 shadow-xl px-4 py-3 md:px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
          {/* Logo & Hardware Telemetry Badge */}
          <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                  RoboArm Studio
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                    4-DOF ESP32-CAM
                  </span>
                </h1>
                <p className="text-[11px] text-slate-400">Mode-Based Teleoperation &amp; Reflex Brain</p>
              </div>
            </div>

            {/* Quick Status indicators (Mobile visible) */}
            <div className="flex md:hidden items-center gap-2">
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-mono border ${
                  wsConnected
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                }`}
              >
                {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                <span>{wsConnected ? 'Brain Online' : 'Brain Offline'}</span>
              </div>
            </div>
          </div>

          {/* Operating Mode Tabs (Safe Switching Protocol) */}
          <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 shadow-inner w-full md:w-auto justify-center">
            <button
              onClick={() => handleSwitchMode('1A')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
                activeMode === '1A'
                  ? 'bg-cyan-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Tier 1A: Manual</span>
            </button>

            <button
              onClick={() => handleSwitchMode('1B')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
                activeMode === '1B'
                  ? 'bg-amber-400 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Tier 1B: Sense &amp; Place</span>
            </button>

            <button
              onClick={() => handleSwitchMode('1C')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all ${
                activeMode === '1C'
                  ? 'bg-purple-500 text-white shadow-md font-bold'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Tier 1C: Vision Sorting</span>
            </button>
          </div>

          {/* Configuration & PERSISTENT EMERGENCY STOP BUTTON */}
          <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end">
            {/* IP / Settings Trigger */}
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="p-2 bg-slate-800/80 hover:bg-slate-800 border border-slate-700 rounded-xl text-slate-300 hover:text-white text-xs flex items-center gap-1.5 transition"
              title="ESP32 IP & WebSocket Settings"
            >
              <Settings2 className="w-4 h-4 text-cyan-400" />
              <span className="hidden sm:inline font-mono">{esp32Ip}</span>
            </button>

            {/* Persistent Global Emergency Stop Button */}
            <button
              onClick={handleTriggerEStop}
              className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider flex items-center gap-2 shadow-lg transition-all ${
                isEStopped
                  ? 'bg-rose-600 text-white animate-pulse ring-4 ring-rose-500/40'
                  : 'bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white shadow-rose-950/80 hover:scale-[1.02]'
              }`}
            >
              <ShieldAlert className="w-5 h-5 text-white animate-bounce" />
              <span>EMERGENCY STOP</span>
            </button>
          </div>
        </div>

        {/* IP & WebSocket Config Dropdown Drawer */}
        {showConfig && (
          <div className="mt-3 pt-3 border-t border-slate-800 max-w-7xl mx-auto flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">ESP32 IP (Video Port 81):</span>
              <input
                type="text"
                value={esp32Ip}
                onChange={(e) => handleSaveIp(e.target.value)}
                placeholder="192.168.1.100"
                className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-slate-200 font-mono focus:border-cyan-500 outline-none w-36"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">FastAPI WS Bridge:</span>
              <input
                type="text"
                value={backendWsUrl}
                onChange={(e) => handleSaveBackendWs(e.target.value)}
                placeholder="ws://localhost:8000/ws"
                className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-slate-200 font-mono focus:border-cyan-500 outline-none w-56"
              />
            </div>

            <button
              onClick={() => {
                setStreamKey(Date.now());
                connectWebSocket();
              }}
              className="px-3 py-1 bg-cyan-600/30 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/50 rounded-lg flex items-center gap-1 transition"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Reconnect &amp; Refresh Video</span>
            </button>
          </div>
        )}
      </header>

      {/* Global E-Stop Active Banner */}
      {isEStopped && (
        <div className="bg-rose-950/90 border-b border-rose-600/50 px-4 py-2.5 text-center text-xs flex items-center justify-center gap-3 animate-fade-in">
          <AlertTriangle className="w-4 h-4 text-rose-400 animate-pulse" />
          <span className="font-semibold text-rose-200">
            EMERGENCY STOP ACTIVE — Kinematic updates halted and target angles locked.
          </span>
          <button
            onClick={handleClearEStop}
            className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-bold text-[11px] shadow uppercase transition flex items-center gap-1"
          >
            <Unlock className="w-3.5 h-3.5" />
            <span>Reset &amp; Resume</span>
          </button>
        </div>
      )}

      {/* =================================================================== */}
      {/* MAIN VIEWPORT CONTENT (3 TIER TABS)                                 */}
      {/* =================================================================== */}
      <main className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full space-y-6">
        {/* ================================================================= */}
        {/* TAB 1: TIER 1A - MANUAL CONTROL                                   */}
        {/* ================================================================= */}
        {activeMode === '1A' && (
          <div className="space-y-6 animate-fade-in">
            {/* Top Telemetry & Status Ribbon */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
                <span className="text-[11px] text-slate-400 block uppercase font-medium">FastAPI Brain</span>
                <div className="flex items-center gap-2 mt-1">
                  <div className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-rose-500'}`} />
                  <span className="font-mono text-xs font-bold text-white">
                    {wsConnected ? 'Connected' : 'Offline'}
                  </span>
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
                <span className="text-[11px] text-slate-400 block uppercase font-medium">ESP32 Hardware</span>
                <div className="flex items-center gap-2 mt-1">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      esp32Status === 'moving'
                        ? 'bg-cyan-400 animate-pulse'
                        : esp32Status === 'stopped'
                        ? 'bg-rose-500'
                        : 'bg-emerald-400'
                    }`}
                  />
                  <span className="font-mono text-xs font-bold capitalize text-white">
                    {esp32Status || 'Idle'}
                  </span>
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
                <span className="text-[11px] text-slate-400 block uppercase font-medium">Obstacle Sonar</span>
                <div className="font-mono text-xs font-bold text-white mt-1">
                  {distanceCm !== null && distanceCm >= 0 ? (
                    <span className={distanceCm < 10 ? 'text-amber-400' : 'text-slate-200'}>
                      {distanceCm.toFixed(1)} cm
                    </span>
                  ) : (
                    <span className="text-slate-500">Out of range</span>
                  )}
                </div>
              </div>

              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5">
                <span className="text-[11px] text-slate-400 block uppercase font-medium">End-Effector Jaw</span>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`font-mono text-xs font-bold ${
                      joints.gripper === 30 ? 'text-emerald-400' : 'text-cyan-400'
                    }`}
                  >
                    {joints.gripper === 30 ? 'OPEN (30°)' : 'CLOSED (135°)'}
                  </span>
                </div>
              </div>
            </div>

            {/* Video & Joint Controls Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left Column: Live MJPEG Video Embed (Port 81) */}
              <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-xl">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900">
                  <div className="flex items-center gap-2">
                    <Video className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                      ESP32-CAM MJPEG Video Stream
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-300">
                      Port 81
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowCrosshairs(!showCrosshairs)}
                      className={`p-1.5 rounded-lg border text-xs transition ${
                        showCrosshairs
                          ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                      title="Toggle Targeting Crosshairs"
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setStreamKey(Date.now())}
                      className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 text-xs transition"
                      title="Reload MJPEG Feed"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Video Container */}
                <div className="relative bg-black flex-1 min-h-[380px] flex items-center justify-center overflow-hidden">
                  <img
                    key={streamKey}
                    src={videoStreamUrl}
                    alt="ESP32-CAM Stream"
                    onLoad={() => {
                      setVideoLoaded(true);
                      setVideoError(false);
                    }}
                    onError={() => {
                      setVideoLoaded(false);
                      setVideoError(true);
                    }}
                    className={`w-full h-full object-contain max-h-[500px] ${videoError ? 'hidden' : 'block'}`}
                  />

                  {/* Fallback Screen if offline */}
                  {videoError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 space-y-3 bg-slate-950/90">
                      <div className="p-3 bg-slate-900 rounded-2xl border border-slate-800 text-slate-500">
                        <VideoOff className="w-8 h-8" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-slate-200">Video Feed Unreachable</p>
                        <p className="text-xs text-slate-400 max-w-sm">
                          Target URL: <code className="text-cyan-400 font-mono">{videoStreamUrl}</code>
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Verify ESP32-CAM power, local Wi-Fi connectivity, and port 81 access.
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          setVideoError(false);
                          setStreamKey(Date.now());
                        }}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl text-xs text-slate-200 font-semibold transition"
                      >
                        Retry Connection
                      </button>
                    </div>
                  )}

                  {/* Targeting Reticle Overlay */}
                  {showCrosshairs && !videoError && (
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div className="w-16 h-16 border border-cyan-400/40 rounded-full flex items-center justify-center">
                        <div className="w-2 h-2 bg-cyan-400/80 rounded-full" />
                      </div>
                      <div className="absolute w-24 h-[1px] bg-cyan-400/30" />
                      <div className="absolute h-24 w-[1px] bg-cyan-400/30" />
                    </div>
                  )}
                </div>

                <div className="px-4 py-2 bg-slate-950 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
                  <span>Stream Protocol: HTTP/MJPEG (QVGA/VGA @ 15-25fps)</span>
                  <span className="font-mono text-emerald-400">Sub-100ms Latency Target</span>
                </div>
              </div>

              {/* Right Column: 4-DOF Joint Sliders & Gripper Toggle */}
              <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-5 shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-wider">Joint Setpoint Controls</h2>
                    <p className="text-[11px] text-slate-400">Throttled WebSocket dispatches to Port 82</p>
                  </div>
                  <button
                    onClick={() => applyPosePreset({ base: 90, shoulder: 90, elbow: 90, gripper: 30 })}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs rounded-lg text-slate-200 font-medium flex items-center gap-1.5 transition"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Neutral (90°)</span>
                  </button>
                </div>

                {/* Sliders Container */}
                <div className="space-y-4">
                  {/* Joint 1: Base */}
                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-cyan-400" />
                        Base Servo (Azimuth)
                      </span>
                      <span className="font-mono text-cyan-400 font-bold bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                        {joints.base}°
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={180}
                      value={joints.base}
                      disabled={isEStopped}
                      onChange={(e) => handleJointChange('base', parseInt(e.target.value, 10))}
                      className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500 disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                      <span>0° (Left)</span>
                      <span>90° (Center)</span>
                      <span>180° (Right)</span>
                    </div>
                  </div>

                  {/* Joint 2: Shoulder */}
                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-indigo-400" />
                        Shoulder Servo (Elevation)
                      </span>
                      <span className="font-mono text-indigo-400 font-bold bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                        {joints.shoulder}°
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={180}
                      value={joints.shoulder}
                      disabled={isEStopped}
                      onChange={(e) => handleJointChange('shoulder', parseInt(e.target.value, 10))}
                      className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500 disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                      <span>0° (Up)</span>
                      <span>90° (Level)</span>
                      <span>180° (Down)</span>
                    </div>
                  </div>

                  {/* Joint 3: Elbow */}
                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800/80 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        Elbow Servo (Pitch)
                      </span>
                      <span className="font-mono text-amber-400 font-bold bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                        {joints.elbow}°
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={180}
                      value={joints.elbow}
                      disabled={isEStopped}
                      onChange={(e) => handleJointChange('elbow', parseInt(e.target.value, 10))}
                      className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                      <span>0° (Retracted)</span>
                      <span>90° (Mid)</span>
                      <span>180° (Extended)</span>
                    </div>
                  </div>

                  {/* Joint 4: Gripper Toggle Button */}
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold text-slate-200 block">End-Effector Gripper</span>
                      <span className="text-[11px] text-slate-400">
                        Current: {joints.gripper === 30 ? '30° (Open)' : '135° (Grip)'}
                      </span>
                    </div>

                    <button
                      onClick={toggleGripper}
                      disabled={isEStopped}
                      className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 shadow-md ${
                        joints.gripper === 30
                          ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950'
                          : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-cyan-950'
                      } disabled:opacity-40`}
                    >
                      {joints.gripper === 30 ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                      <span>{joints.gripper === 30 ? 'OPEN GRIPPER' : 'CLOSE GRIPPER'}</span>
                    </button>
                  </div>
                </div>

                {/* Kinematic Quick Presets */}
                <div className="pt-2 border-t border-slate-800 space-y-2">
                  <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider block">
                    Quick Kinematic Presets
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => applyPosePreset({ base: 90, shoulder: 120, elbow: 110, gripper: 30 })}
                      disabled={isEStopped}
                      className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-800 text-[11px] rounded-lg text-slate-200 border border-slate-700 font-medium transition disabled:opacity-40"
                    >
                      Reach Ground
                    </button>
                    <button
                      onClick={() => applyPosePreset({ base: 90, shoulder: 60, elbow: 60, gripper: 135 })}
                      disabled={isEStopped}
                      className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-800 text-[11px] rounded-lg text-slate-200 border border-slate-700 font-medium transition disabled:opacity-40"
                    >
                      Elevate High
                    </button>
                    <button
                      onClick={() => applyPosePreset({ base: 160, shoulder: 110, elbow: 100, gripper: 135 })}
                      disabled={isEStopped}
                      className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-800 text-[11px] rounded-lg text-slate-200 border border-slate-700 font-medium transition disabled:opacity-40"
                    >
                      Bin Deposit
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 2: TIER 1B - SENSE & PLACE                                    */}
        {/* ================================================================= */}
        {activeMode === '1B' && (
          <div className="space-y-6 animate-fade-in">
            {/* Header info banner */}
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-amber-500/20 rounded-xl text-amber-400 border border-amber-500/30">
                  <Activity className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Tier 1B: Autonomous Sense &amp; Place</h3>
                  <p className="text-xs text-slate-300">
                    Proximity trigger reflex: When ultrasonic distance drops below 10cm, the arm automatically grasps and transfers the object.
                  </p>
                </div>
              </div>

              <button
                onClick={triggerSimulatedPickAndPlace}
                disabled={isExecutingSequence || isEStopped}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-xl flex items-center gap-2 shadow-lg transition self-start sm:self-auto"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Test Cycle Trigger</span>
              </button>
            </div>

            {/* Metrics & Gauges Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Distance Readout & Proximity Bar */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Ultrasonic Proximity
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-mono font-semibold border ${
                      distanceCm !== null && distanceCm < 10
                        ? 'bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse'
                        : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    }`}
                  >
                    {distanceCm !== null && distanceCm < 10 ? 'OBJECT IN RANGE (<10cm)' : 'TARGET SEARCHING'}
                  </span>
                </div>

                <div className="text-center py-4 bg-slate-950 rounded-xl border border-slate-800">
                  <div className="text-4xl font-extrabold font-mono text-white">
                    {distanceCm !== null && distanceCm >= 0 ? distanceCm.toFixed(1) : '--'}
                    <span className="text-sm font-normal text-slate-400 ml-1.5">cm</span>
                  </div>
                  <span className="text-[11px] text-slate-500 mt-1 block">Trigger Threshold: 10.0 cm</span>
                </div>

                {/* Progress Visualizer */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Proximity Gauge (0 - 40cm)</span>
                    <span className="font-mono">{distanceCm ? `${Math.min(distanceCm, 40).toFixed(0)}cm` : '0cm'}</span>
                  </div>
                  <div className="w-full bg-slate-950 h-3 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className={`h-full transition-all duration-300 ${
                        distanceCm !== null && distanceCm < 10
                          ? 'bg-rose-500'
                          : distanceCm !== null && distanceCm < 20
                          ? 'bg-amber-400'
                          : 'bg-cyan-500'
                      }`}
                      style={{
                        width: `${distanceCm !== null ? Math.min(100, Math.max(5, (distanceCm / 40) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Task State Machine Indicator */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl flex flex-col justify-between">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-2">
                    Autonomous State Machine
                  </span>
                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center space-y-1">
                    <span className="text-xs text-slate-400 block">Current Operating Phase:</span>
                    <span
                      className={`text-xl font-bold font-mono tracking-tight block ${
                        isExecutingSequence ? 'text-amber-400 animate-pulse' : 'text-emerald-400'
                      }`}
                    >
                      {isExecutingSequence ? 'EXECUTING PICK & PLACE' : 'IDLE / DETECTING'}
                    </span>
                    <span className="text-xs text-slate-400 block pt-1">
                      {isExecutingSequence ? `Step: ${sequenceStepName}` : 'Awaiting distance < 10cm trigger'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs p-3 bg-slate-950 rounded-xl border border-slate-800">
                  <span className="text-slate-400">Reflex Mode:</span>
                  <span className="font-bold text-amber-400">Tier 1B Active</span>
                </div>
              </div>

              {/* Total Pick Count Tracker */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Performance Telemetry
                    </span>
                    <button
                      onClick={() => {
                        setPickCount(0);
                        localStorage.setItem('roboarm_pick_count', '0');
                      }}
                      className="text-[11px] text-slate-400 hover:text-white underline transition"
                    >
                      Reset Count
                    </button>
                  </div>

                  <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-center">
                    <span className="text-xs text-slate-400 block">Total Completed Picks:</span>
                    <div className="text-4xl font-extrabold font-mono text-cyan-400 mt-1">{pickCount}</div>
                    <span className="text-[11px] text-slate-500 mt-1 block">Cycles successfully transferred</span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800">
                  <span>Cycle Duration:</span>
                  <span className="font-mono text-slate-200">~6.8s per object</span>
                </div>
              </div>
            </div>

            {/* 7-Step Kinematic Sequence Visualizer */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <Layers className="w-4 h-4 text-amber-400" />
                Kinematic Sequence Timeline (7 Steps)
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
                {[
                  { step: 1, name: 'Pre-Grasp Approach', angle: '90°/115°/105°/30°' },
                  { step: 2, name: 'Grip Target', angle: 'Jaw Close (135°)' },
                  { step: 3, name: 'Vertical Clearance', angle: 'Elevate (75°/75°)' },
                  { step: 4, name: 'Azimuth Swing', angle: 'Base Rotate (160°)' },
                  { step: 5, name: 'Descend to Tray', angle: 'Drop Pose (110°)' },
                  { step: 6, name: 'Release Gripper', angle: 'Jaw Open (30°)' },
                  { step: 7, name: 'Return to Home', angle: 'Center Neutral (90°)' },
                ].map((item) => {
                  const isActive = isExecutingSequence && currentSequenceStep === item.step;
                  const isDone = isExecutingSequence && currentSequenceStep > item.step;

                  return (
                    <div
                      key={item.step}
                      className={`p-3 rounded-xl border transition-all text-xs flex flex-col justify-between ${
                        isActive
                          ? 'bg-amber-500/20 border-amber-500 text-white ring-2 ring-amber-500/30'
                          : isDone
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-slate-950 border-slate-800 text-slate-400'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono font-bold">Step {item.step}</span>
                        {isDone ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : isActive ? (
                          <div className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                        ) : null}
                      </div>
                      <div className="font-semibold text-slate-200">{item.name}</div>
                      <div className="text-[10px] font-mono text-slate-500 mt-2">{item.angle}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 3: TIER 1C - VISION SORTING                                   */}
        {/* ================================================================= */}
        {activeMode === '1C' && (
          <div className="space-y-6 animate-fade-in">
            {/* Header info */}
            <div className="bg-purple-500/10 border border-purple-500/20 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-purple-500/20 rounded-xl text-purple-400 border border-purple-500/30">
                  <Eye className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Tier 1C: Computer Vision Shape Classifier &amp; Sorter</h3>
                  <p className="text-xs text-slate-300">
                    Real-time neural detection model classifying shapes and assigning automated target drop bins.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAiOverlayEnabled(!aiOverlayEnabled)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                    aiOverlayEnabled
                      ? 'bg-purple-600/30 text-purple-300 border-purple-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700'
                  }`}
                >
                  {aiOverlayEnabled ? 'Overlay: ON' : 'Overlay: OFF'}
                </button>
              </div>
            </div>

            {/* Shape Badges Row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Shape 1: Cube */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
                    <Box className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">Cube (Box)</h4>
                    <span className="text-[11px] text-slate-400">Target: Bin A</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono font-bold text-cyan-400">
                    {detectedShapes.cube.confidence}%
                  </span>
                  <span className="text-[10px] text-slate-500 block">Confidence</span>
                </div>
              </div>

              {/* Shape 2: Sphere */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/30 rounded-xl text-indigo-400">
                    <Circle className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">Sphere (Ball)</h4>
                    <span className="text-[11px] text-slate-400">Target: Bin B</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono font-bold text-indigo-400">
                    {detectedShapes.sphere.confidence}%
                  </span>
                  <span className="text-[10px] text-slate-500 block">Confidence</span>
                </div>
              </div>

              {/* Shape 3: Pyramid */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400">
                    <Triangle className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">Pyramid (Cone)</h4>
                    <span className="text-[11px] text-slate-400">Target: Bin C</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono font-bold text-amber-400">
                    {detectedShapes.pyramid.confidence}%
                  </span>
                  <span className="text-[10px] text-slate-500 block">Confidence</span>
                </div>
              </div>
            </div>

            {/* Video Viewport with AI Annotation Canvas + Sort Table */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Annotated Feed */}
              <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-xl">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-200 flex items-center gap-2">
                    <Eye className="w-4 h-4 text-purple-400" />
                    Model Inference Feed
                  </span>
                  <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                    MobileNet / YOLO-Nano
                  </span>
                </div>

                <div className="relative bg-black flex-1 min-h-[360px] flex items-center justify-center overflow-hidden">
                  <img
                    key={`cv-${streamKey}`}
                    src={videoStreamUrl}
                    alt="Vision Input"
                    onError={(e) => {
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                    className="w-full h-full object-contain max-h-[460px]"
                  />

                  {/* Simulated Bounding Box Overlay for Hackathon visual */}
                  {aiOverlayEnabled && (
                    <div className="absolute inset-0 pointer-events-none p-8 flex items-center justify-center">
                      <div className="relative border-2 border-cyan-400 bg-cyan-500/10 rounded-lg w-48 h-48 flex flex-col justify-between p-2">
                        <div className="flex items-center justify-between">
                          <span className="bg-cyan-500 text-slate-950 font-bold font-mono text-[10px] px-1.5 py-0.5 rounded">
                            Cube 96.4%
                          </span>
                          <span className="text-[9px] font-mono text-cyan-300">Target: Bin A</span>
                        </div>
                        <div className="text-[9px] font-mono text-cyan-300 text-right">
                          X: 160 Y: 120 Z: -15
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Simulation trigger buttons for demo */}
                <div className="p-3 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-xs">
                  <span className="text-slate-400 text-[11px]">Simulate Vision Event:</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => addSimulatedVisionSort('Cube')}
                      className="px-2.5 py-1 bg-cyan-600/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-600/40 rounded-lg text-[11px] transition"
                    >
                      + Cube (Bin A)
                    </button>
                    <button
                      onClick={() => addSimulatedVisionSort('Sphere')}
                      className="px-2.5 py-1 bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-600/40 rounded-lg text-[11px] transition"
                    >
                      + Sphere (Bin B)
                    </button>
                    <button
                      onClick={() => addSimulatedVisionSort('Pyramid')}
                      className="px-2.5 py-1 bg-amber-600/20 text-amber-300 border border-amber-500/30 hover:bg-amber-600/40 rounded-lg text-[11px] transition"
                    >
                      + Pyramid (Bin C)
                    </button>
                  </div>
                </div>
              </div>

              {/* Live Sort Log Table */}
              <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl flex flex-col">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    Live Sorting Event Log
                  </span>
                  <span className="text-[11px] font-mono text-slate-400">{sortLogs.length} events logged</span>
                </div>

                <div className="flex-1 overflow-x-auto overflow-y-auto max-h-[380px] bg-slate-950 rounded-xl border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900 text-slate-400 uppercase text-[10px] tracking-wider sticky top-0 border-b border-slate-800">
                      <tr>
                        <th className="px-3 py-2.5 font-semibold">Time</th>
                        <th className="px-3 py-2.5 font-semibold">Shape</th>
                        <th className="px-3 py-2.5 font-semibold">Conf.</th>
                        <th className="px-3 py-2.5 font-semibold">Bin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80 font-mono text-[11px]">
                      {sortLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-900/50 transition">
                          <td className="px-3 py-2 text-slate-400">{log.timestamp}</td>
                          <td className="px-3 py-2 text-white font-medium flex items-center gap-1.5">
                            {log.shape === 'Cube' ? (
                              <Box className="w-3.5 h-3.5 text-cyan-400" />
                            ) : log.shape === 'Sphere' ? (
                              <Circle className="w-3.5 h-3.5 text-indigo-400" />
                            ) : (
                              <Triangle className="w-3.5 h-3.5 text-amber-400" />
                            )}
                            {log.shape}
                          </td>
                          <td className="px-3 py-2 text-emerald-400">{log.confidence}%</td>
                          <td className="px-3 py-2 text-slate-300">{log.destinationBin}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 px-6 py-3 text-center text-xs text-slate-500">
        ESP32-CAM Robotic Arm Dual-Port Command System &bull; WebSocket Port 82 &bull; MJPEG Port 81 &bull; FastAPI Backend Port 8000
      </footer>
    </div>
  );
}
