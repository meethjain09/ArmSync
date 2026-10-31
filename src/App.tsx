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
  Crosshair,
  Gauge,
  Sparkles,
  ChevronRight,
  Terminal,
  Zap,
  Sun,
  Moon
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
  // Theme State: 'dark' (Deep Space Obsidian) or 'light' (Clean Industrial Laboratory White)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('roboarm_theme') as 'dark' | 'light') || 'dark';
  });

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('roboarm_theme', nextTheme);
  };

  // Dynamic Connection URLs (Vercel Hybrid Setup: configurable for local Wi-Fi / IP shifts)
  const [fastApiBrainUrl, setFastApiBrainUrl] = useState<string>(() => {
    return localStorage.getItem('roboarm_fastapi_brain_url') || 'ws://localhost:8000/ws';
  });
  const [cameraStreamUrl, setCameraStreamUrl] = useState<string>(() => {
    return localStorage.getItem('roboarm_camera_stream_url') || 'http://192.168.1.100:81/stream';
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

  // Save dynamic connection URLs to state and localStorage
  const handleSaveCameraUrl = (url: string) => {
    setCameraStreamUrl(url);
    localStorage.setItem('roboarm_camera_stream_url', url);
    setStreamKey(Date.now());
  };

  const handleSaveFastApiBrainUrl = (url: string) => {
    setFastApiBrainUrl(url);
    localStorage.setItem('roboarm_fastapi_brain_url', url);
  };

  // ---------------------------------------------------------------------------
  // WebSocket Bridge Connection
  // ---------------------------------------------------------------------------
  const sendWebSocketMessage = useCallback((payload: Record<string, any>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log('WS Payload:', JSON.stringify(payload));
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const targetUrl = fastApiBrainUrl.trim();
    if (!targetUrl) return;

    try {
      const socket = new WebSocket(targetUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setWsConnected(true);
        console.log('[WS] Connected to FastAPI Brain:', targetUrl);
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

          // Emergency Stop alert (Only if explicit user STOP triggered)
          if (data.type === 'ESTOP_TRIGGERED') {
            setIsEStopped(true);
            setEStopReason('Emergency Stop Triggered');
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
  }, [fastApiBrainUrl]);

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
    setEsp32Status('idle');

    // Update frontend joint setpoints to home pose
    const homePose: JointAngles = {
      base: 90,
      shoulder: 90,
      elbow: 90,
      gripper: 30,
    };
    setJoints(homePose);
    lastSentJoints.current = homePose;

    // Send explicit MOVE command to force hardware to unlock its E-Stop latch and return to home
    sendWebSocketMessage({
      command: 'MOVE',
      base: 90,
      shoulder: 90,
      elbow: 90,
      gripper: 30,
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
    (newJoints: JointAngles, immediate: boolean = false) => {
      if (isEStopped) return;

      lastSentJoints.current = newJoints;

      const unifiedPayload = {
        command: 'MOVE',
        base: Math.round(Number(newJoints.base)),
        shoulder: Math.round(Number(newJoints.shoulder)),
        elbow: Math.round(Number(newJoints.elbow)),
        gripper: Math.round(Number(newJoints.gripper)),
      };

      if (immediate) {
        if (throttleTimeoutRef.current) {
          clearTimeout(throttleTimeoutRef.current);
          throttleTimeoutRef.current = null;
        }
        sendWebSocketMessage(unifiedPayload);
        return;
      }

      if (!throttleTimeoutRef.current) {
        throttleTimeoutRef.current = setTimeout(() => {
          sendWebSocketMessage({
            command: 'MOVE',
            base: Math.round(Number(lastSentJoints.current.base)),
            shoulder: Math.round(Number(lastSentJoints.current.shoulder)),
            elbow: Math.round(Number(lastSentJoints.current.elbow)),
            gripper: Math.round(Number(lastSentJoints.current.gripper)),
          });
          throttleTimeoutRef.current = null;
        }, 50); // 20Hz update rate
      }
    },
    [isEStopped, sendWebSocketMessage]
  );

  const handleJointChange = (joint: keyof JointAngles, value: number) => {
    const updated = { ...joints, [joint]: Math.round(Number(value)) };
    setJoints(updated);
    if (activeMode === '1A') {
      dispatchJoints(updated);
    }
  };

  const toggleGripper = () => {
    if (isEStopped) return;

    // Use latest state from lastSentJoints.current or joints to prevent stale closure
    const currentGripper = lastSentJoints.current.gripper;
    const nextAngle: number = currentGripper === 30 ? 90 : 30;

    // Build the guaranteed fresh unified state
    const nextJoints: JointAngles = {
      base: Math.round(Number(lastSentJoints.current.base)),
      shoulder: Math.round(Number(lastSentJoints.current.shoulder)),
      elbow: Math.round(Number(lastSentJoints.current.elbow)),
      gripper: nextAngle,
    };

    // Update synchronous ref FIRST so subsequent slider events immediately inherit the new gripper value
    lastSentJoints.current = nextJoints;

    // Clear any pending throttle timers to avoid overwriting with a stale payload
    if (throttleTimeoutRef.current) {
      clearTimeout(throttleTimeoutRef.current);
      throttleTimeoutRef.current = null;
    }

    // Update React state
    setJoints(nextJoints);

    // Direct, immediate dispatch using the freshly computed value (never relying on async React re-render)
    const payload = {
      command: 'MOVE',
      base: nextJoints.base,
      shoulder: nextJoints.shoulder,
      elbow: nextJoints.elbow,
      gripper: nextJoints.gripper,
    };

    if (activeMode === '1A') {
      sendWebSocketMessage(payload);
    }
  };

  const applyPosePreset = (preset: { base: number; shoulder: number; elbow: number; gripper: number }) => {
    const cleanPreset: JointAngles = {
      base: Math.round(Number(preset.base)),
      shoulder: Math.round(Number(preset.shoulder)),
      elbow: Math.round(Number(preset.elbow)),
      gripper: Math.round(Number(preset.gripper)),
    };
    setJoints(cleanPreset);
    if (activeMode === '1A') {
      dispatchJoints(cleanPreset, true);
    }
  };

  // Camera Video URL generator (Handles full http/https URLs or raw IP addresses)
  const buildVideoUrl = (rawTarget: string, key: number): string | null => {
    if (!rawTarget) return null;
    const trimmed = rawTarget.trim();
    if (!trimmed) return null;

    let base = trimmed;
    // If user provided just an IP or hostname without protocol (e.g. 192.168.1.100)
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      if (base.includes(':81')) {
        base = `http://${base}`;
      } else {
        base = `http://${base}:81/stream`;
      }
    }
    // Append stream path if omitted
    if (!base.endsWith('/stream') && !base.includes('/stream?') && !base.includes('?')) {
      base = `${base.replace(/\/+$/, '')}/stream`;
    }

    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}key=${key}`;
  };

  const videoStreamUrl = buildVideoUrl(cameraStreamUrl, streamKey);

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

  const isLight = theme === 'light';

  return (
    <div
      className={`min-h-screen flex flex-col font-sans transition-colors duration-300 relative overflow-x-hidden ${
        isLight
          ? 'theme-light bg-[#f8fafc] text-slate-800 bg-grid-cyber-light selection:bg-sky-500 selection:text-white'
          : 'bg-[#070913] text-slate-100 bg-grid-cyber selection:bg-rose-500 selection:text-white'
      }`}
    >
      {/* Background Ambient Glow Accents */}
      {!isLight ? (
        <>
          <div className="fixed -top-40 -left-40 w-96 h-96 bg-cyan-500/10 rounded-full blur-[120px] pointer-events-none" />
          <div className="fixed top-1/3 -right-40 w-96 h-96 bg-purple-500/10 rounded-full blur-[140px] pointer-events-none" />
          <div className="fixed -bottom-40 left-1/3 w-[500px] h-[500px] bg-rose-500/5 rounded-full blur-[160px] pointer-events-none" />
        </>
      ) : (
        <>
          <div className="fixed -top-40 -left-40 w-96 h-96 bg-sky-200/40 rounded-full blur-[100px] pointer-events-none" />
          <div className="fixed top-1/3 -right-40 w-96 h-96 bg-indigo-100/60 rounded-full blur-[120px] pointer-events-none" />
          <div className="fixed -bottom-40 left-1/3 w-[500px] h-[500px] bg-rose-100/40 rounded-full blur-[140px] pointer-events-none" />
        </>
      )}

      {/* =================================================================== */}
      {/* PERSISTENT HEADER & GLOBAL E-STOP PINNED AT TOP                     */}
      {/* =================================================================== */}
      <header
        className={`sticky top-0 z-50 backdrop-blur-xl border-b transition-all duration-300 px-4 py-3.5 md:px-7 ${
          isLight
            ? 'bg-white/80 border-slate-200/80 shadow-md'
            : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
        }`}
      >
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3.5">
          {/* Logo & Hardware Telemetry Badge */}
          <div className="flex items-center gap-3.5 w-full md:w-auto justify-between md:justify-start">
            <div className="flex items-center gap-3">
              <div className="relative group">
                <div
                  className={`absolute -inset-0.5 rounded-2xl blur transition duration-300 ${
                    isLight
                      ? 'bg-gradient-to-r from-sky-400 to-indigo-400 opacity-40 group-hover:opacity-75'
                      : 'bg-gradient-to-r from-cyan-500 to-indigo-500 opacity-60 group-hover:opacity-100'
                  }`}
                />
                <div
                  className={`relative p-2.5 rounded-2xl border transition-colors ${
                    isLight
                      ? 'bg-white border-slate-200 text-sky-600 shadow-sm'
                      : 'bg-[#0B0F19] border-white/10 text-cyan-400 shadow-inner'
                  }`}
                >
                  <Cpu className="w-5 h-5 animate-pulse" />
                </div>
              </div>
              <div>
                <h1
                  className={`text-base font-bold tracking-tight flex items-center gap-2 ${
                    isLight ? 'text-slate-900' : 'text-white'
                  }`}
                >
                  RoboArm Studio
                  <span
                    className={`text-[10px] font-mono tracking-widest px-2.5 py-0.5 rounded-full border ${
                      isLight
                        ? 'bg-sky-50 text-sky-700 border-sky-200'
                        : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                    }`}
                  >
                    4-DOF ESP32-CAM
                  </span>
                </h1>
                <p className={`text-[11px] font-medium ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  Kinematic Teleoperation &amp; Machine Reflex Engine
                </p>
              </div>
            </div>

            {/* Quick Status indicators (Mobile visible) */}
            <div className="flex md:hidden items-center gap-2">
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono border backdrop-blur-md transition-colors ${
                  wsConnected
                    ? isLight
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : isLight
                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                    : 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                }`}
              >
                {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                <span>{wsConnected ? 'Brain Online' : 'Brain Offline'}</span>
              </div>
            </div>
          </div>

          {/* Operating Mode Tabs */}
          <div
            className={`flex items-center p-1.5 rounded-2xl border shadow-inner w-full md:w-auto justify-center backdrop-blur-md transition-colors ${
              isLight
                ? 'bg-slate-100/90 border-slate-200 shadow-slate-200/50'
                : 'bg-[#070913]/90 border-white/10 shadow-[inset_0_2px_8px_rgba(0,0,0,0.6)]'
            }`}
          >
            <button
              onClick={() => handleSwitchMode('1A')}
              className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all duration-300 cursor-pointer ${
                activeMode === '1A'
                  ? isLight
                    ? 'bg-white text-sky-700 font-bold shadow-md shadow-slate-200 scale-[1.02]'
                    : 'bg-gradient-to-r from-cyan-500 to-sky-400 text-slate-950 font-bold shadow-[0_0_20px_rgba(6,182,212,0.4)] scale-[1.02]'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Tier 1A: Manual</span>
            </button>

            <button
              onClick={() => handleSwitchMode('1B')}
              className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all duration-300 cursor-pointer ${
                activeMode === '1B'
                  ? isLight
                    ? 'bg-white text-amber-700 font-bold shadow-md shadow-slate-200 scale-[1.02]'
                    : 'bg-gradient-to-r from-amber-400 to-orange-400 text-slate-950 font-bold shadow-[0_0_20px_rgba(251,191,36,0.4)] scale-[1.02]'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Tier 1B: Sense &amp; Place</span>
            </button>

            <button
              onClick={() => handleSwitchMode('1C')}
              className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all duration-300 cursor-pointer ${
                activeMode === '1C'
                  ? isLight
                    ? 'bg-white text-purple-700 font-bold shadow-md shadow-slate-200 scale-[1.02]'
                    : 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white font-bold shadow-[0_0_20px_rgba(168,85,247,0.4)] scale-[1.02]'
                  : isLight
                  ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Tier 1C: Vision Sorting</span>
            </button>
          </div>

          {/* Right Toolbar: Theme Toggle, Config, & Global E-Stop */}
          <div className="flex items-center gap-2.5 w-full md:w-auto justify-between md:justify-end">
            {/* White / Dark Mode Toggle Button */}
            <button
              onClick={toggleTheme}
              className={`p-2.5 rounded-xl border text-xs flex items-center gap-1.5 transition-all duration-200 cursor-pointer ${
                isLight
                  ? 'bg-white hover:bg-slate-100 border-slate-200 text-amber-600 shadow-sm'
                  : 'bg-white/5 hover:bg-white/10 border-white/10 text-amber-300'
              }`}
              title={isLight ? 'Switch to Deep Space Dark Theme' : 'Switch to Clean Laboratory White Theme'}
            >
              {isLight ? <Moon className="w-4 h-4 text-indigo-600" /> : <Sun className="w-4 h-4 text-amber-400" />}
              <span className="hidden xl:inline font-mono text-[11px] font-semibold">
                {isLight ? 'Dark' : 'Light'}
              </span>
            </button>

            {/* Connection Settings Trigger */}
            <button
              onClick={() => setShowConfig(!showConfig)}
              className={`p-2.5 rounded-xl border text-xs flex items-center gap-2 transition-all duration-200 cursor-pointer ${
                isLight
                  ? 'bg-white hover:bg-slate-100 border-slate-200 text-slate-700 shadow-sm'
                  : 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300'
              }`}
              title="FastAPI Brain & Camera Stream Settings"
            >
              <Settings2 className="w-4 h-4 text-sky-500" />
              <span className="hidden sm:inline font-mono text-[11px] font-semibold">
                Network Settings
              </span>
            </button>

            {/* Persistent Global Emergency Stop Button */}
            <button
              onClick={handleTriggerEStop}
              className={`relative px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider flex items-center gap-2 shadow-2xl transition-all duration-300 cursor-pointer ${
                isEStopped
                  ? 'bg-rose-600 text-white animate-pulse ring-4 ring-rose-500/50 shadow-[0_0_30px_rgba(244,63,94,0.6)]'
                  : 'bg-gradient-to-r from-rose-600 via-rose-500 to-red-600 hover:from-rose-500 hover:to-red-500 active:scale-95 text-white shadow-[0_0_20px_rgba(225,29,72,0.4)] hover:shadow-[0_0_25px_rgba(225,29,72,0.6)]'
              }`}
            >
              <ShieldAlert className="w-4 h-4 text-white animate-bounce" />
              <span className="drop-shadow-sm font-extrabold tracking-widest">EMERGENCY STOP</span>
            </button>
          </div>
        </div>

        {/* Connection Settings Dropdown Drawer (Hybrid Vercel + Local Laptop Setup) */}
        {showConfig && (
          <div
            className={`mt-3.5 pt-3.5 border-t max-w-7xl mx-auto space-y-3.5 animate-in fade-in slide-in-from-top-2 duration-300 ${
              isLight ? 'border-slate-200 text-slate-700' : 'border-white/10 text-slate-300'
            }`}
          >
            <div className="flex flex-wrap items-center gap-4 text-xs">
              {/* Field 1: FastAPI Brain URL */}
              <div
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border flex-1 min-w-[300px] ${
                  isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/5 border-white/10'
                }`}
              >
                <span className="font-semibold whitespace-nowrap">FastAPI Brain URL:</span>
                <input
                  type="text"
                  value={fastApiBrainUrl}
                  onChange={(e) => handleSaveFastApiBrainUrl(e.target.value)}
                  placeholder="ws://localhost:8000/ws or ws://192.168.x.x:8000/ws"
                  className={`border rounded-lg px-2.5 py-1 font-mono font-semibold outline-none flex-1 text-xs transition ${
                    isLight
                      ? 'bg-white border-slate-300 text-sky-700 focus:border-sky-500'
                      : 'bg-black/60 border-white/15 text-cyan-300 focus:border-cyan-400'
                  }`}
                />
              </div>

              {/* Field 2: Camera Stream URL */}
              <div
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border flex-1 min-w-[300px] ${
                  isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/5 border-white/10'
                }`}
              >
                <span className="font-semibold whitespace-nowrap">Camera Stream URL:</span>
                <input
                  type="text"
                  value={cameraStreamUrl}
                  onChange={(e) => handleSaveCameraUrl(e.target.value)}
                  placeholder="http://192.168.x.x:81/stream"
                  className={`border rounded-lg px-2.5 py-1 font-mono font-semibold outline-none flex-1 text-xs transition ${
                    isLight
                      ? 'bg-white border-slate-300 text-sky-700 focus:border-sky-500'
                      : 'bg-black/60 border-white/15 text-cyan-300 focus:border-cyan-400'
                  }`}
                />
              </div>

              {/* Reconnect & Refresh Button */}
              <button
                onClick={() => {
                  setStreamKey(Date.now());
                  connectWebSocket();
                }}
                className={`px-4 py-2 rounded-xl flex items-center gap-2 transition-all shadow-sm font-semibold cursor-pointer border text-xs shrink-0 ${
                  isLight
                    ? 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100'
                    : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30'
                }`}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reconnect &amp; Refresh</span>
              </button>
            </div>

            {/* Mixed Content Warning Note for Vercel Deployment */}
            <div
              className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs ${
                isLight
                  ? 'bg-amber-50/90 border-amber-200 text-amber-900 shadow-sm'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
              }`}
            >
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-bold tracking-wide text-amber-600 dark:text-amber-400 block text-[11px] uppercase">
                  Vercel Mixed Content Notice
                </span>
                <p className="text-[12px] leading-relaxed">
                  Note: If connecting to local IPs from Vercel, you must allow 'Insecure Content' in your browser site settings.
                </p>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Global E-Stop Active Banner */}
      {isEStopped && (
        <div className="bg-gradient-to-r from-rose-950/90 via-red-950/90 to-rose-950/90 backdrop-blur-md border-b border-rose-500/40 px-4 py-2.5 text-center text-xs flex items-center justify-center gap-3 animate-pulse shadow-[0_4px_20px_rgba(244,63,94,0.3)]">
          <AlertTriangle className="w-4 h-4 text-rose-400" />
          <span className="font-semibold text-rose-100 tracking-wide">
            EMERGENCY STOP ACTIVE — Kinematic updates halted and target angles locked.
          </span>
          <button
            onClick={handleClearEStop}
            className="px-3.5 py-1 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white rounded-lg font-bold text-[11px] shadow-[0_0_15px_rgba(244,63,94,0.5)] uppercase tracking-wider transition-transform active:scale-95 flex items-center gap-1.5 cursor-pointer"
          >
            <Unlock className="w-3.5 h-3.5" />
            <span>Reset &amp; Resume</span>
          </button>
        </div>
      )}

      {/* =================================================================== */}
      {/* MAIN VIEWPORT CONTENT (3 TIER TABS)                                 */}
      {/* =================================================================== */}
      <main className="flex-1 p-4 md:p-6 lg:p-8 max-w-7xl mx-auto w-full space-y-6 z-10">
        {/* ================================================================= */}
        {/* TAB 1: TIER 1A - MANUAL CONTROL                                   */}
        {/* ================================================================= */}
        {activeMode === '1A' && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Top Telemetry & Status Ribbon */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              <div
                className={`backdrop-blur-xl border rounded-2xl p-4 shadow-sm transition-all group ${
                  isLight
                    ? 'bg-white/80 border-slate-200/90 hover:border-sky-300'
                    : 'bg-[#0B0F19]/70 border-white/10 hover:border-cyan-500/30 shadow-xl'
                }`}
              >
                <span className={`text-[10px] block uppercase font-mono tracking-wider font-semibold ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  FastAPI Brain
                </span>
                <div className="flex items-center gap-2 mt-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-rose-500 shadow-[0_0_8px_#f43f5e]'}`} />
                  <span className={`font-mono text-xs font-bold tracking-wide ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {wsConnected ? 'Connected' : 'Offline'}
                  </span>
                </div>
              </div>

              <div
                className={`backdrop-blur-xl border rounded-2xl p-4 shadow-sm transition-all group ${
                  isLight
                    ? 'bg-white/80 border-slate-200/90 hover:border-sky-300'
                    : 'bg-[#0B0F19]/70 border-white/10 hover:border-cyan-500/30 shadow-xl'
                }`}
              >
                <span className={`text-[10px] block uppercase font-mono tracking-wider font-semibold ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  ESP32 Hardware
                </span>
                <div className="flex items-center gap-2 mt-1.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${
                      esp32Status === 'moving'
                        ? 'bg-cyan-500 animate-pulse'
                        : esp32Status === 'stopped'
                        ? 'bg-rose-500'
                        : 'bg-emerald-500'
                    }`}
                  />
                  <span className={`font-mono text-xs font-bold capitalize tracking-wide ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {esp32Status || 'Idle'}
                  </span>
                </div>
              </div>

              <div
                className={`backdrop-blur-xl border rounded-2xl p-4 shadow-sm transition-all group ${
                  isLight
                    ? 'bg-white/80 border-slate-200/90 hover:border-sky-300'
                    : 'bg-[#0B0F19]/70 border-white/10 hover:border-cyan-500/30 shadow-xl'
                }`}
              >
                <span className={`text-[10px] block uppercase font-mono tracking-wider font-semibold ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  Obstacle Sonar
                </span>
                <div className={`font-mono text-xs font-bold mt-1.5 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                  {distanceCm !== null && distanceCm >= 0 ? (
                    <span className={distanceCm < 10 ? 'text-amber-600 font-extrabold' : isLight ? 'text-slate-800' : 'text-slate-200'}>
                      {distanceCm.toFixed(1)} <span className={`text-[10px] font-normal ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>cm</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">Out of range</span>
                  )}
                </div>
              </div>

              <div
                className={`backdrop-blur-xl border rounded-2xl p-4 shadow-sm transition-all group ${
                  isLight
                    ? 'bg-white/80 border-slate-200/90 hover:border-sky-300'
                    : 'bg-[#0B0F19]/70 border-white/10 hover:border-cyan-500/30 shadow-xl'
                }`}
              >
                <span className={`text-[10px] block uppercase font-mono tracking-wider font-semibold ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  End-Effector Jaw
                </span>
                <div className="flex items-center gap-2 mt-1.5">
                  <span
                    className={`font-mono text-xs font-bold tracking-wide ${
                      joints.gripper === 30
                        ? isLight
                          ? 'text-emerald-600'
                          : 'text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]'
                        : isLight
                        ? 'text-sky-600'
                        : 'text-cyan-400 drop-shadow-[0_0_8px_rgba(56,189,248,0.4)]'
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
              <div
                className={`lg:col-span-7 backdrop-blur-xl border rounded-3xl overflow-hidden flex flex-col relative shadow-xl ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div
                  className={`px-5 py-3.5 border-b flex items-center justify-between ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/[0.02] border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`p-1.5 rounded-lg border ${
                        isLight ? 'bg-sky-50 border-sky-200 text-sky-600' : 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400'
                      }`}
                    >
                      <Video className="w-4 h-4" />
                    </div>
                    <span className={`text-xs font-bold uppercase tracking-wider ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                      ESP32-CAM MJPEG Video Stream
                    </span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                        isLight ? 'bg-sky-50 text-sky-700 border-sky-200' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                      }`}
                    >
                      Port 81
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowCrosshairs(!showCrosshairs)}
                      className={`p-2 rounded-xl border text-xs transition-all cursor-pointer ${
                        showCrosshairs
                          ? isLight
                            ? 'bg-sky-100 text-sky-700 border-sky-300'
                            : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                          : isLight
                          ? 'bg-slate-100 text-slate-500 border-slate-200 hover:text-slate-900'
                          : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
                      }`}
                      title="Toggle Targeting Crosshairs"
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setStreamKey(Date.now())}
                      className={`p-2 rounded-xl border text-xs transition cursor-pointer ${
                        isLight
                          ? 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
                          : 'bg-white/5 hover:bg-white/10 text-slate-300 border-white/10'
                      }`}
                      title="Reload MJPEG Feed"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Video Container */}
                <div className="relative bg-black flex-1 min-h-[380px] flex items-center justify-center overflow-hidden group">
                  {videoStreamUrl ? (
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
                      className={`w-full h-full object-contain max-h-[500px] transition-opacity duration-300 ${videoError ? 'hidden' : 'block'}`}
                    />
                  ) : (
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center text-center p-6 space-y-3 backdrop-blur-md ${
                        isLight ? 'bg-slate-100/95' : 'bg-[#0B0F19]/95'
                      }`}
                    >
                      <div className={`p-4 rounded-3xl border ${isLight ? 'bg-white border-slate-200 text-slate-400' : 'bg-white/5 border-white/10 text-slate-500'}`}>
                        <VideoOff className="w-8 h-8" />
                      </div>
                      <div className="space-y-1">
                        <p className={`text-sm font-semibold ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                          No Camera Stream Configured
                        </p>
                        <p className={`text-xs max-w-sm ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                          Set the ESP32-CAM IP or Stream URL in hardware settings to connect the live MJPEG feed.
                        </p>
                      </div>
                      <button
                        onClick={() => setShowConfig(true)}
                        className={`px-4 py-2 border rounded-xl text-xs font-semibold transition cursor-pointer shadow-sm ${
                          isLight
                            ? 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100'
                            : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30'
                        }`}
                      >
                        Open Hardware Config
                      </button>
                    </div>
                  )}

                  {/* Fallback Screen if offline */}
                  {videoStreamUrl && videoError && (
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center text-center p-6 space-y-3 backdrop-blur-md ${
                        isLight ? 'bg-slate-100/95' : 'bg-[#0B0F19]/95'
                      }`}
                    >
                      <div className={`p-4 rounded-3xl border ${isLight ? 'bg-white border-slate-200 text-slate-400' : 'bg-white/5 border-white/10 text-slate-500'}`}>
                        <VideoOff className="w-8 h-8" />
                      </div>
                      <div className="space-y-1">
                        <p className={`text-sm font-semibold ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                          Video Feed Unreachable
                        </p>
                        <p className={`text-xs max-w-sm ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                          Target URL: <code className={`font-mono font-semibold ${isLight ? 'text-sky-600' : 'text-cyan-400'}`}>{videoStreamUrl}</code>
                        </p>
                        <p className="text-[11px] text-slate-400">
                          Verify ESP32-CAM power rail, local Wi-Fi pairing, and port 81 access.
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          setVideoError(false);
                          setStreamKey(Date.now());
                        }}
                        className={`px-4 py-2 border rounded-xl text-xs font-semibold transition cursor-pointer shadow-sm ${
                          isLight
                            ? 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100'
                            : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30'
                        }`}
                      >
                        Retry Video Link
                      </button>
                    </div>
                  )}

                  {/* Targeting Reticle */}
                  {showCrosshairs && videoStreamUrl && !videoError && (
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div className="w-20 h-20 border border-cyan-400/50 rounded-full flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.3)]">
                        <div className="w-2 h-2 bg-cyan-400 rounded-full shadow-[0_0_8px_#38bdf8]" />
                      </div>
                      <div className="absolute w-32 h-[1px] bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />
                      <div className="absolute h-32 w-[1px] bg-gradient-to-b from-transparent via-cyan-400/60 to-transparent" />
                      <span className="absolute bottom-4 left-4 text-[10px] font-mono text-cyan-300/80 tracking-wider bg-black/40 px-2 py-0.5 rounded">
                        CAM_OVERLAY: ACTIVE [640x480]
                      </span>
                    </div>
                  )}
                </div>

                <div
                  className={`px-5 py-2.5 border-t text-[11px] flex items-center justify-between font-mono ${
                    isLight ? 'bg-slate-50 border-slate-200 text-slate-500' : 'bg-black/40 border-white/10 text-slate-400'
                  }`}
                >
                  <span>Stream Protocol: HTTP/MJPEG (QVGA/VGA @ 15-25fps)</span>
                  <span className="text-emerald-500 font-semibold flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
                    Sub-100ms Latency Target
                  </span>
                </div>
              </div>

              {/* Right Column: 4-DOF Joint Sliders & Gripper Toggle */}
              <div
                className={`lg:col-span-5 backdrop-blur-xl border rounded-3xl p-6 space-y-6 shadow-xl ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div
                  className={`flex items-center justify-between border-b pb-4 ${
                    isLight ? 'border-slate-200' : 'border-white/10'
                  }`}
                >
                  <div>
                    <h2 className={`text-sm font-bold uppercase tracking-wider flex items-center gap-2 ${isLight ? 'text-slate-900' : 'text-white'}`}>
                      <Sliders className={`w-4 h-4 ${isLight ? 'text-sky-600' : 'text-cyan-400'}`} />
                      Joint Setpoint Controls
                    </h2>
                    <p className={`text-[11px] font-medium ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                      Throttled WebSocket dispatches to Port 82
                    </p>
                  </div>
                  <button
                    onClick={() => applyPosePreset({ base: 90, shoulder: 90, elbow: 90, gripper: 30 })}
                    className={`px-3 py-1.5 border text-xs rounded-xl font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                      isLight
                        ? 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
                        : 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-200'
                    }`}
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${isLight ? 'text-sky-600' : 'text-cyan-400'}`} />
                    <span>Neutral (90°)</span>
                  </button>
                </div>

                {/* Sliders Container */}
                <div className="space-y-4">
                  {/* Joint 1: Base */}
                  <div
                    className={`p-4 rounded-2xl border transition-all space-y-2.5 ${
                      isLight
                        ? 'bg-slate-50/80 border-slate-200 hover:border-sky-300'
                        : 'bg-white/[0.03] border-white/10 hover:border-cyan-500/30'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className={`font-semibold flex items-center gap-2 ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                        <span className="w-2 h-2 rounded-full bg-sky-500" />
                        Base Servo (Azimuth)
                      </span>
                      <span
                        className={`font-mono font-bold px-2.5 py-0.5 rounded-lg border ${
                          isLight
                            ? 'bg-white text-sky-700 border-slate-200 shadow-sm'
                            : 'bg-[#070913] text-cyan-300 border-cyan-500/20 shadow-inner'
                        }`}
                      >
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
                      className="w-full cyber-slider disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                      <span>0° (Left)</span>
                      <span>90° (Center)</span>
                      <span>180° (Right)</span>
                    </div>
                  </div>

                  {/* Joint 2: Shoulder */}
                  <div
                    className={`p-4 rounded-2xl border transition-all space-y-2.5 ${
                      isLight
                        ? 'bg-slate-50/80 border-slate-200 hover:border-indigo-300'
                        : 'bg-white/[0.03] border-white/10 hover:border-indigo-500/30'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className={`font-semibold flex items-center gap-2 ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                        <span className="w-2 h-2 rounded-full bg-indigo-500" />
                        Shoulder Servo (Elevation)
                      </span>
                      <span
                        className={`font-mono font-bold px-2.5 py-0.5 rounded-lg border ${
                          isLight
                            ? 'bg-white text-indigo-700 border-slate-200 shadow-sm'
                            : 'bg-[#070913] text-indigo-300 border-indigo-500/20 shadow-inner'
                        }`}
                      >
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
                      className="w-full cyber-slider disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                      <span>0° (Up)</span>
                      <span>90° (Level)</span>
                      <span>180° (Down)</span>
                    </div>
                  </div>

                  {/* Joint 3: Elbow */}
                  <div
                    className={`p-4 rounded-2xl border transition-all space-y-2.5 ${
                      isLight
                        ? 'bg-slate-50/80 border-slate-200 hover:border-amber-300'
                        : 'bg-white/[0.03] border-white/10 hover:border-amber-500/30'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className={`font-semibold flex items-center gap-2 ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                        <span className="w-2 h-2 rounded-full bg-amber-500" />
                        Elbow Servo (Pitch)
                      </span>
                      <span
                        className={`font-mono font-bold px-2.5 py-0.5 rounded-lg border ${
                          isLight
                            ? 'bg-white text-amber-700 border-slate-200 shadow-sm'
                            : 'bg-[#070913] text-amber-300 border-amber-500/20 shadow-inner'
                        }`}
                      >
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
                      className="w-full cyber-slider disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                      <span>0° (Retracted)</span>
                      <span>90° (Mid)</span>
                      <span>180° (Extended)</span>
                    </div>
                  </div>

                  {/* Joint 4: Gripper Toggle Button */}
                  <div
                    className={`p-4 rounded-2xl border flex items-center justify-between ${
                      isLight ? 'bg-slate-50/80 border-slate-200' : 'bg-white/[0.03] border-white/10'
                    }`}
                  >
                    <div>
                      <span className={`text-xs font-semibold block ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                        End-Effector Gripper
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono">
                        Current: {joints.gripper === 30 ? '30° (Open)' : '90° (Grip)'}
                      </span>
                    </div>

                    <button
                      onClick={toggleGripper}
                      disabled={isEStopped}
                      className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 flex items-center gap-2 shadow-lg cursor-pointer ${
                        joints.gripper === 30
                          ? isLight
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
                            : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-extrabold shadow-[0_0_20px_rgba(16,185,129,0.3)]'
                          : isLight
                          ? 'bg-sky-600 hover:bg-sky-500 text-white shadow-sky-600/30'
                          : 'bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-slate-950 font-extrabold shadow-[0_0_20px_rgba(6,182,212,0.3)]'
                      } disabled:opacity-40`}
                    >
                      {joints.gripper === 30 ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                      <span>{joints.gripper === 30 ? 'OPEN GRIPPER' : 'CLOSE GRIPPER'}</span>
                    </button>
                  </div>
                </div>

                {/* Kinematic Quick Presets */}
                <div className={`pt-3 border-t space-y-2.5 ${isLight ? 'border-slate-200' : 'border-white/10'}`}>
                  <span className={`text-[10px] font-mono font-bold uppercase tracking-wider block ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                    Kinematic Target Presets
                  </span>
                  <div className="grid grid-cols-3 gap-2.5">
                    <button
                      onClick={() => applyPosePreset({ base: 90, shoulder: 120, elbow: 110, gripper: 30 })}
                      disabled={isEStopped}
                      className={`px-3 py-2 text-[11px] rounded-xl border font-medium transition cursor-pointer disabled:opacity-40 ${
                        isLight
                          ? 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
                          : 'bg-white/5 hover:bg-white/10 text-slate-200 border-white/10'
                      }`}
                    >
                      Reach Ground
                    </button>
                    <button
                      onClick={() => applyPosePreset({ base: 90, shoulder: 60, elbow: 60, gripper: 135 })}
                      disabled={isEStopped}
                      className={`px-3 py-2 text-[11px] rounded-xl border font-medium transition cursor-pointer disabled:opacity-40 ${
                        isLight
                          ? 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
                          : 'bg-white/5 hover:bg-white/10 text-slate-200 border-white/10'
                      }`}
                    >
                      Elevate High
                    </button>
                    <button
                      onClick={() => applyPosePreset({ base: 160, shoulder: 110, elbow: 100, gripper: 135 })}
                      disabled={isEStopped}
                      className={`px-3 py-2 text-[11px] rounded-xl border font-medium transition cursor-pointer disabled:opacity-40 ${
                        isLight
                          ? 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'
                          : 'bg-white/5 hover:bg-white/10 text-slate-200 border-white/10'
                      }`}
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
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Header info banner */}
            <div
              className={`border rounded-3xl p-5 backdrop-blur-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl ${
                isLight
                  ? 'bg-amber-50/70 border-amber-200 text-slate-800'
                  : 'bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-amber-500/30'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div
                  className={`p-3 rounded-2xl border ${
                    isLight ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                  }`}
                >
                  <Activity className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h3 className={`text-sm font-bold tracking-wide ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    Tier 1B: Autonomous Sense &amp; Place
                  </h3>
                  <p className={`text-xs mt-0.5 ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
                    Proximity trigger reflex: When ultrasonic distance drops below 10cm, the arm automatically grasps and transfers the object.
                  </p>
                </div>
              </div>

              <button
                onClick={triggerSimulatedPickAndPlace}
                disabled={isExecutingSequence || isEStopped}
                className="px-5 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 disabled:opacity-40 text-slate-950 font-extrabold text-xs rounded-xl flex items-center gap-2 shadow-lg transition cursor-pointer self-start sm:self-auto"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Test Cycle Trigger</span>
              </button>
            </div>

            {/* Metrics & Gauges Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Distance Readout & Proximity Bar */}
              <div
                className={`backdrop-blur-xl border rounded-3xl p-6 space-y-5 shadow-xl ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-bold uppercase tracking-wider font-mono ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                    Ultrasonic Proximity
                  </span>
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-mono font-semibold border ${
                      distanceCm !== null && distanceCm < 10
                        ? isLight
                          ? 'bg-rose-50 text-rose-700 border-rose-200'
                          : 'bg-rose-500/15 text-rose-300 border-rose-500/40 animate-pulse'
                        : isLight
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                    }`}
                  >
                    {distanceCm !== null && distanceCm < 10 ? 'OBJECT IN RANGE (<10cm)' : 'TARGET SEARCHING'}
                  </span>
                </div>

                <div className={`text-center py-6 rounded-2xl border ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-black/40 border-white/5'}`}>
                  <div className={`text-5xl font-black font-mono tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {distanceCm !== null && distanceCm >= 0 ? distanceCm.toFixed(1) : '--'}
                    <span className="text-sm font-normal text-slate-400 ml-2 font-mono">cm</span>
                  </div>
                  <span className="text-[11px] text-slate-400 mt-2 block font-mono">Trigger Threshold: 10.0 cm</span>
                </div>

                {/* Progress Visualizer */}
                <div className="space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                    <span>Proximity Gauge (0 - 40cm)</span>
                    <span className={`font-semibold ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                      {distanceCm ? `${Math.min(distanceCm, 40).toFixed(0)}cm` : '0cm'}
                    </span>
                  </div>
                  <div className={`w-full h-3.5 rounded-full overflow-hidden border p-0.5 ${isLight ? 'bg-slate-100 border-slate-200' : 'bg-black/60 border-white/10'}`}>
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        distanceCm !== null && distanceCm < 10
                          ? 'bg-rose-500'
                          : distanceCm !== null && distanceCm < 20
                          ? 'bg-amber-400'
                          : 'bg-sky-500'
                      }`}
                      style={{
                        width: `${distanceCm !== null ? Math.min(100, Math.max(5, (distanceCm / 40) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Task State Machine Indicator */}
              <div
                className={`backdrop-blur-xl border rounded-3xl p-6 space-y-5 shadow-xl flex flex-col justify-between ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div>
                  <span className={`text-xs font-bold uppercase tracking-wider font-mono block mb-3 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                    Autonomous State Machine
                  </span>
                  <div className={`p-5 rounded-2xl border text-center space-y-2 ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-black/40 border-white/5'}`}>
                    <span className="text-xs text-slate-400 block font-mono">Current Operating Phase:</span>
                    <span
                      className={`text-xl font-black font-mono tracking-wide block ${
                        isExecutingSequence
                          ? 'text-amber-500 animate-pulse'
                          : isLight
                          ? 'text-emerald-600'
                          : 'text-emerald-400'
                      }`}
                    >
                      {isExecutingSequence ? 'EXECUTING PICK & PLACE' : 'IDLE / DETECTING'}
                    </span>
                    <span className="text-xs text-slate-400 block pt-1 font-mono">
                      {isExecutingSequence ? `Step: ${sequenceStepName}` : 'Awaiting distance < 10cm trigger'}
                    </span>
                  </div>
                </div>

                <div className={`flex items-center justify-between text-xs p-3.5 rounded-2xl border font-mono ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/5 border-white/10'}`}>
                  <span className={isLight ? 'text-slate-500' : 'text-slate-400'}>Reflex Mode:</span>
                  <span className="font-bold text-amber-500">Tier 1B Active</span>
                </div>
              </div>

              {/* Total Pick Count Tracker */}
              <div
                className={`backdrop-blur-xl border rounded-3xl p-6 space-y-5 shadow-xl flex flex-col justify-between ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`text-xs font-bold uppercase tracking-wider font-mono ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                      Performance Telemetry
                    </span>
                    <button
                      onClick={() => {
                        setPickCount(0);
                        localStorage.setItem('roboarm_pick_count', '0');
                      }}
                      className="text-[11px] text-sky-600 hover:text-sky-500 font-mono font-semibold transition cursor-pointer"
                    >
                      Reset Count
                    </button>
                  </div>

                  <div className={`p-5 rounded-2xl border text-center ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-black/40 border-white/5'}`}>
                    <span className="text-xs text-slate-400 block font-mono">Total Completed Picks:</span>
                    <div className={`text-5xl font-black font-mono mt-1 ${isLight ? 'text-sky-600' : 'text-cyan-400'}`}>
                      {pickCount}
                    </div>
                    <span className="text-[11px] text-slate-400 mt-2 block font-mono">Cycles successfully transferred</span>
                  </div>
                </div>

                <div className={`text-[11px] flex items-center justify-between p-3.5 rounded-2xl border font-mono ${isLight ? 'bg-slate-50 border-slate-200 text-slate-500' : 'bg-white/5 border-white/10 text-slate-400'}`}>
                  <span>Cycle Duration:</span>
                  <span className={`font-semibold ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>~6.8s per object</span>
                </div>
              </div>
            </div>

            {/* 7-Step Kinematic Sequence Visualizer */}
            <div
              className={`backdrop-blur-xl border rounded-3xl p-6 space-y-4 shadow-xl ${
                isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
              }`}
            >
              <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 font-mono ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                <Layers className="w-4 h-4 text-amber-500" />
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
                      className={`p-3.5 rounded-2xl border transition-all duration-300 text-xs flex flex-col justify-between ${
                        isActive
                          ? 'bg-amber-500/20 border-amber-500 text-amber-900 ring-1 ring-amber-400 scale-[1.03]'
                          : isDone
                          ? isLight
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : isLight
                          ? 'bg-slate-50 border-slate-200 text-slate-500'
                          : 'bg-black/40 border-white/5 text-slate-400'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono font-bold text-[11px]">Step {item.step}</span>
                        {isDone ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : isActive ? (
                          <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-ping" />
                        ) : null}
                      </div>
                      <div className={`font-semibold ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>{item.name}</div>
                      <div className="text-[10px] font-mono text-slate-400 mt-2.5">{item.angle}</div>
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
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Header info banner */}
            <div
              className={`border rounded-3xl p-5 backdrop-blur-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl ${
                isLight
                  ? 'bg-purple-50/70 border-purple-200 text-slate-800'
                  : 'bg-gradient-to-r from-purple-500/10 via-purple-500/5 to-transparent border-purple-500/30'
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div
                  className={`p-3 rounded-2xl border ${
                    isLight ? 'bg-purple-100 text-purple-700 border-purple-200' : 'bg-purple-500/20 text-purple-400 border-purple-500/30'
                  }`}
                >
                  <Eye className="w-5 h-5 animate-pulse" />
                </div>
                <div>
                  <h3 className={`text-sm font-bold tracking-wide ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    Tier 1C: Computer Vision Shape Classifier &amp; Sorter
                  </h3>
                  <p className={`text-xs mt-0.5 ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
                    Real-time neural detection model classifying shapes and assigning automated target drop bins.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAiOverlayEnabled(!aiOverlayEnabled)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
                    aiOverlayEnabled
                      ? isLight
                        ? 'bg-purple-100 text-purple-700 border-purple-300'
                        : 'bg-purple-600/30 text-purple-200 border-purple-500/40 shadow-[0_0_15px_rgba(168,85,247,0.3)]'
                      : isLight
                      ? 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
                  }`}
                >
                  {aiOverlayEnabled ? 'Overlay: ON' : 'Overlay: OFF'}
                </button>
              </div>
            </div>

            {/* Shape Badges Row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Shape 1: Cube */}
              <div
                className={`backdrop-blur-xl border rounded-3xl p-5 flex items-center justify-between transition-all shadow-md ${
                  isLight
                    ? 'bg-white border-slate-200 hover:border-sky-300'
                    : 'bg-[#0B0F19]/80 border-white/10 hover:border-cyan-500/40 shadow-xl'
                }`}
              >
                <div className="flex items-center gap-3.5">
                  <div className={`p-3 rounded-2xl border ${isLight ? 'bg-sky-50 border-sky-200 text-sky-600' : 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400'}`}>
                    <Box className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className={`text-xs font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>Cube (Box)</h4>
                    <span className="text-[11px] text-slate-400 font-mono">Target: Bin A</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`text-sm font-mono font-bold ${isLight ? 'text-sky-600' : 'text-cyan-400'}`}>
                    {detectedShapes.cube.confidence}%
                  </span>
                  <span className="text-[10px] text-slate-400 block font-mono">Confidence</span>
                </div>
              </div>

              {/* Shape 2: Sphere */}
              <div
                className={`backdrop-blur-xl border rounded-3xl p-5 flex items-center justify-between transition-all shadow-md ${
                  isLight
                    ? 'bg-white border-slate-200 hover:border-indigo-300'
                    : 'bg-[#0B0F19]/80 border-white/10 hover:border-indigo-500/40 shadow-xl'
                }`}
              >
                <div className="flex items-center gap-3.5">
                  <div className={`p-3 rounded-2xl border ${isLight ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'}`}>
                    <Circle className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className={`text-xs font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>Sphere (Ball)</h4>
                    <span className="text-[11px] text-slate-400 font-mono">Target: Bin B</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`text-sm font-mono font-bold ${isLight ? 'text-indigo-600' : 'text-indigo-400'}`}>
                    {detectedShapes.sphere.confidence}%
                  </span>
                  <span className="text-[10px] text-slate-400 block font-mono">Confidence</span>
                </div>
              </div>

              {/* Shape 3: Pyramid */}
              <div
                className={`backdrop-blur-xl border rounded-3xl p-5 flex items-center justify-between transition-all shadow-md ${
                  isLight
                    ? 'bg-white border-slate-200 hover:border-amber-300'
                    : 'bg-[#0B0F19]/80 border-white/10 hover:border-amber-500/40 shadow-xl'
                }`}
              >
                <div className="flex items-center gap-3.5">
                  <div className={`p-3 rounded-2xl border ${isLight ? 'bg-amber-50 border-amber-200 text-amber-600' : 'bg-amber-500/15 border-amber-500/30 text-amber-400'}`}>
                    <Triangle className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className={`text-xs font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>Pyramid (Cone)</h4>
                    <span className="text-[11px] text-slate-400 font-mono">Target: Bin C</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`text-sm font-mono font-bold ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                    {detectedShapes.pyramid.confidence}%
                  </span>
                  <span className="text-[10px] text-slate-400 block font-mono">Confidence</span>
                </div>
              </div>
            </div>

            {/* Video Viewport with AI Annotation Canvas + Sort Table */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Annotated Feed */}
              <div
                className={`lg:col-span-7 backdrop-blur-xl border rounded-3xl overflow-hidden flex flex-col shadow-xl ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div
                  className={`px-5 py-3.5 border-b flex items-center justify-between ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/[0.02] border-white/10'
                  }`}
                >
                  <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-2 font-mono ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                    <Eye className="w-4 h-4 text-purple-500" />
                    Model Inference Feed
                  </span>
                  <span
                    className={`text-[10px] font-mono px-2.5 py-0.5 rounded-full border ${
                      isLight
                        ? 'text-purple-700 bg-purple-50 border-purple-200'
                        : 'text-purple-300 bg-purple-500/15 border-purple-500/30'
                    }`}
                  >
                    MobileNet / YOLO-Nano
                  </span>
                </div>

                <div className="relative bg-black flex-1 min-h-[360px] flex items-center justify-center overflow-hidden">
                  {videoStreamUrl ? (
                    <img
                      key={`cv-${streamKey}`}
                      src={videoStreamUrl}
                      alt="Vision Input"
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                      className="w-full h-full object-contain max-h-[460px]"
                    />
                  ) : (
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center text-center p-6 space-y-2 backdrop-blur-md ${
                        isLight ? 'bg-slate-100/95' : 'bg-[#0B0F19]/95'
                      }`}
                    >
                      <div className={`p-3 rounded-2xl border ${isLight ? 'bg-white border-slate-200 text-slate-400' : 'bg-white/5 border-white/10 text-slate-500'}`}>
                        <VideoOff className="w-6 h-6" />
                      </div>
                      <p className={`text-xs font-semibold ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                        Camera Feed Inactive
                      </p>
                      <p className={`text-[11px] max-w-xs ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                        Connect ESP32-CAM stream to run real-time inference on live camera frames.
                      </p>
                    </div>
                  )}

                  {/* Simulated Bounding Box Overlay */}
                  {aiOverlayEnabled && (
                    <div className="absolute inset-0 pointer-events-none p-8 flex items-center justify-center">
                      <div className="relative border-2 border-cyan-400 bg-cyan-500/10 rounded-2xl w-52 h-52 flex flex-col justify-between p-3 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
                        <div className="flex items-center justify-between">
                          <span className="bg-cyan-500 text-slate-950 font-bold font-mono text-[10px] px-2 py-0.5 rounded shadow">
                            Cube 96.4%
                          </span>
                          <span className="text-[10px] font-mono text-cyan-300 bg-black/50 px-1.5 py-0.5 rounded">Target: Bin A</span>
                        </div>
                        <div className="text-[10px] font-mono text-cyan-300 text-right bg-black/50 px-1.5 py-0.5 rounded self-end">
                          X: 160 Y: 120 Z: -15
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Simulation trigger buttons */}
                <div
                  className={`p-3.5 border-t flex items-center justify-between text-xs ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-black/40 border-white/10'
                  }`}
                >
                  <span className="text-slate-400 text-[11px] font-mono">Simulate Vision Event:</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => addSimulatedVisionSort('Cube')}
                      className={`px-3 py-1 rounded-xl text-[11px] font-mono transition cursor-pointer border ${
                        isLight
                          ? 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100'
                          : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25'
                      }`}
                    >
                      + Cube (Bin A)
                    </button>
                    <button
                      onClick={() => addSimulatedVisionSort('Sphere')}
                      className={`px-3 py-1 rounded-xl text-[11px] font-mono transition cursor-pointer border ${
                        isLight
                          ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
                          : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/25'
                      }`}
                    >
                      + Sphere (Bin B)
                    </button>
                    <button
                      onClick={() => addSimulatedVisionSort('Pyramid')}
                      className={`px-3 py-1 rounded-xl text-[11px] font-mono transition cursor-pointer border ${
                        isLight
                          ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25'
                      }`}
                    >
                      + Pyramid (Bin C)
                    </button>
                  </div>
                </div>
              </div>

              {/* Live Sort Log Table */}
              <div
                className={`lg:col-span-5 backdrop-blur-xl border rounded-3xl p-6 space-y-4 shadow-xl flex flex-col ${
                  isLight ? 'bg-white border-slate-200' : 'bg-[#0B0F19]/80 border-white/10 shadow-2xl'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-bold uppercase tracking-wider font-mono ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                    Live Sorting Event Log
                  </span>
                  <span
                    className={`text-[11px] font-mono px-2.5 py-0.5 rounded-full border ${
                      isLight ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-white/5 text-slate-400 border-white/10'
                    }`}
                  >
                    {sortLogs.length} events logged
                  </span>
                </div>

                <div
                  className={`flex-1 overflow-x-auto overflow-y-auto max-h-[380px] rounded-2xl border ${
                    isLight ? 'bg-slate-50 border-slate-200' : 'bg-black/40 border-white/10 shadow-inner'
                  }`}
                >
                  <table className="w-full text-left text-xs">
                    <thead
                      className={`uppercase text-[10px] tracking-wider sticky top-0 border-b backdrop-blur-md ${
                        isLight ? 'bg-slate-100/90 text-slate-600 border-slate-200' : 'bg-[#070913]/90 text-slate-400 border-white/10'
                      }`}
                    >
                      <tr>
                        <th className="px-3.5 py-3 font-semibold font-mono">Time</th>
                        <th className="px-3.5 py-3 font-semibold font-mono">Shape</th>
                        <th className="px-3.5 py-3 font-semibold font-mono">Conf.</th>
                        <th className="px-3.5 py-3 font-semibold font-mono">Bin</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y font-mono text-[11px] ${isLight ? 'divide-slate-200' : 'divide-white/5'}`}>
                      {sortLogs.map((log) => (
                        <tr key={log.id} className={`transition-colors ${isLight ? 'hover:bg-slate-100/60' : 'hover:bg-white/[0.03]'}`}>
                          <td className="px-3.5 py-2.5 text-slate-400">{log.timestamp}</td>
                          <td className={`px-3.5 py-2.5 font-medium flex items-center gap-2 ${isLight ? 'text-slate-800' : 'text-white'}`}>
                            {log.shape === 'Cube' ? (
                              <Box className="w-3.5 h-3.5 text-sky-500" />
                            ) : log.shape === 'Sphere' ? (
                              <Circle className="w-3.5 h-3.5 text-indigo-500" />
                            ) : (
                              <Triangle className="w-3.5 h-3.5 text-amber-500" />
                            )}
                            {log.shape}
                          </td>
                          <td className="px-3.5 py-2.5 text-emerald-600 font-bold">{log.confidence}%</td>
                          <td className={`px-3.5 py-2.5 ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>{log.destinationBin}</td>
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
      <footer
        className={`border-t px-6 py-4 text-center text-xs font-mono transition-colors ${
          isLight ? 'border-slate-200 text-slate-500 bg-white/50' : 'border-white/5 text-slate-500 bg-transparent'
        }`}
      >
        ESP32-CAM Robotic Arm Dual-Port Command System &bull; WebSocket Port 82 &bull; MJPEG Port 81 &bull; FastAPI Backend Port 8000
      </footer>
    </div>
  );
}
