import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, Mic, FileText, AlertCircle, Video, Square, Download, CheckCircle, XCircle } from 'lucide-react';

// The environment provides the API key at runtime.
const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

export default function App() {
  const [sessionState, setSessionState] = useState('idle'); // idle, connecting, active, ended
  const [aiText, setAiText] = useState("Waiting to start inspection...");
  const [snapshots, setSnapshots] = useState([]);
  const [error, setError] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [telemetry, setTelemetry] = useState({ framesSent: 0, lastFrameTime: "None", apiStatus: "IDLE" });
  const lastAnalysisTimeRef = useRef(0);

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioSourceRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioProcessorRef = useRef(null);
  const videoIntervalRef = useRef(null);

  // Load jsPDF dynamically on mount
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    document.head.appendChild(script);

    return () => stopAll(); // Cleanup on unmount
  }, []);

  const stopAll = useCallback(() => {
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      if (videoRef.current.src) {
        URL.revokeObjectURL(videoRef.current.src);
        videoRef.current.src = "";
      }
      videoRef.current.srcObject = null;
    }
  }, []);

  const handleStart = async (mode = 'live', file = null) => {
    setError("");
    setSnapshots([]);
    setAiText(mode === 'live' ? "Requesting camera access..." : "Preparing video for analysis...");
    setSessionState('active');
    setTelemetry(prev => ({ ...prev, apiStatus: "ACTIVE" }));

    try {
      if (mode === 'live') {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 768 }, height: { ideal: 768 } }
        });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } else if (mode === 'upload' && file) {
        const url = URL.createObjectURL(file);
        if (videoRef.current) {
          videoRef.current.src = url;
          videoRef.current.currentTime = 0;
          videoRef.current.onended = handleStop; // Stop analysis when video ends
          await new Promise((resolve) => {
            videoRef.current.onloadedmetadata = resolve;
          });
          videoRef.current.play();
        }
      }

      // The effect below will start the analysis loop automatically when state becomes active

    } catch (err) {
      setError(`Failed to initialize: ${err.message}`);
      setSessionState('idle');
    }
  };

  // Analysis Loop Effect (Recursive setTimeout with 10s safety gap)
  useEffect(() => {
    let timeoutId = null;
    let isActive = true;

    const runAnalysis = async () => {
      if (sessionState !== 'active' || !isActive) return;

      // Rate limit safety: ensure 5 seconds between requests
      const now = Date.now();
      const elapsed = now - lastAnalysisTimeRef.current;
      if (elapsed < 5000) {
        timeoutId = setTimeout(runAnalysis, 5000 - elapsed);
        return;
      }

      if (!canvasRef.current || !videoRef.current) {
        timeoutId = setTimeout(runAnalysis, 2000);
        return;
      }

      lastAnalysisTimeRef.current = now;
      console.log(`[Analysis] Processing frame #${telemetry.framesSent + 1}...`);

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = videoRef.current.videoWidth || 720;
      canvas.height = videoRef.current.videoHeight || 720;
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
      const base64Data = dataUrl.split(',')[1];
      const timeStr = new Date().toLocaleTimeString();

      setIsScanning(true);
      setTelemetry(prev => ({ ...prev, framesSent: prev.framesSent + 1, lastFrameTime: timeStr }));
      setTimeout(() => setIsScanning(false), 500);

      try {
        const fetchWithRetry = async (url, options, retries = 2, backoff = 2000) => {
          try {
            const res = await fetch(url, options);
            if (!res.ok && (res.status === 503 || res.status === 500) && retries > 0) {
              console.warn(`[Analysis] API busy (${res.status}). Retrying in ${backoff}ms...`);
              await new Promise(r => setTimeout(r, backoff));
              return fetchWithRetry(url, options, retries - 1, backoff * 2);
            }
            return res;
          } catch (e) {
            if (retries > 0) {
              await new Promise(r => setTimeout(r, backoff));
              return fetchWithRetry(url, options, retries - 1, backoff * 2);
            }
            throw e;
          }
        };

        const response = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: "Analyze this frame for vehicle/property damage. Return a JSON object with: { damage_found: boolean, component: string, type: string, severity: number, description: string }. Only return JSON." },
                { inline_data: { mime_type: "image/jpeg", data: base64Data } }
              ]
            }],
            generationConfig: {
              response_mime_type: "application/json"
            }
          })
        });

        if (response.status === 429) {
          console.warn("[Analysis] Rate limit hit. Cooling down for 15s...");
          setAiText("AI system cooling down (rate limit)...");
          timeoutId = setTimeout(runAnalysis, 15000);
          return;
        }

        if (!response.ok) {
          console.error(`[Analysis] API Unreachable (${response.status})`);
          timeoutId = setTimeout(runAnalysis, 5000);
          return;
        }

        const data = await response.json();
        const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const result = JSON.parse(jsonText);
        
        console.log("[Analysis] JSON Result:", result);

        if (result.damage_found) {
          handleManualCapture(
            result.component || "Unknown Part",
            result.type || "Undefined Damage",
            result.severity || 5,
            result.description || "No detailed assessment provided.",
            dataUrl
          );
        } else {
          setAiText("Scanning... No new damage detected.");
        }

      } catch (err) {
        console.error("[Analysis] Error:", err);
      }

      if (isActive) {
        timeoutId = setTimeout(runAnalysis, 5000); // Wait 5s before next scan
      }
    };

    if (sessionState === 'active') {
      console.log("[Analysis] Scan sequence initiated. Waiting 2s for video warm-up...");
      // Initialize with a 3s offset so the first scan happens in 2s (due to 5s gap check)
      lastAnalysisTimeRef.current = Date.now() - 3000; 
      runAnalysis();
    }

    return () => {
      isActive = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [sessionState]);

  const handleManualCapture = (component, classification, severity, description, image) => {
    const snapshotData = {
      id: Date.now(),
      component,
      classification,
      severity: parseInt(severity) || 5,
      description,
      image,
      timestamp: new Date().toLocaleTimeString()
    };
    setSnapshots(prev => {
      // Small deduplication check
      const exists = prev.some(s => s.component === component && s.classification === classification);
      if (exists) return prev;
      return [...prev, snapshotData];
    });
    setAiText(`Detected damage: ${classification} on ${component}.`);
  };

  const handleStop = () => {
    stopAll();
    setSessionState('ended');
    setAiText("Inspection ended. You can now generate your report.");
  };

  const generatePDF = () => {
    if (!window.jspdf) {
      setError("PDF library is still loading, please try again in a moment.");
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.width;

    // Header
    doc.setFontSize(22);
    doc.setTextColor(40);
    doc.text("AI Damage Assessment Report", pageWidth / 2, 20, { align: "center" });

    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(`Generated on: ${new Date().toLocaleString()}`, pageWidth / 2, 28, { align: "center" });

    doc.setDrawColor(200);
    doc.line(20, 32, pageWidth - 20, 32);

    let yOffset = 45;

    if (snapshots.length === 0) {
      doc.setFontSize(14);
      doc.setTextColor(40);
      doc.text("No damage was identified during this session.", 20, yOffset);
    } else {
      snapshots.forEach((snap, index) => {
        // Pagination check
        if (yOffset > 220) {
          doc.addPage();
          yOffset = 20;
        }

        doc.setFontSize(14);
        doc.setTextColor(40);
        doc.setFont(undefined, 'bold');
        doc.text(`Finding ${index + 1}: ${snap.component} - ${snap.classification}`, 20, yOffset);
        
        doc.setFontSize(11);
        doc.setFont(undefined, 'italic');
        doc.setTextColor(80);
        
        // Dynamic text wrapping and height calculation
        const descriptionLines = doc.splitTextToSize(snap.description, pageWidth - 40);
        doc.text(descriptionLines, 20, yOffset + 8);
        
        // Move yOffset based on description length
        const descriptionHeight = (descriptionLines.length * 5) + 5;
        const severityY = yOffset + 8 + descriptionHeight;

        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(120);
        doc.text(`Severity: ${snap.severity}/10  |  Time logged: ${snap.timestamp}`, 20, severityY);

        // Add Image below everything
        doc.addImage(snap.image, 'JPEG', 20, severityY + 8, 120, 90);

        yOffset = severityY + 110;
      });
    }

    doc.save("Vehicle_Damage_Report.pdf");
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header Section */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-6 rounded-2xl shadow-sm border border-neutral-200">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Camera className="text-blue-600" />
              Real-Time AI Adjuster
            </h1>
            <p className="text-neutral-500 mt-1">Zero-backend prototype using Gemini 2.0 Live API</p>
          </div>

          <div className="mt-4 sm:mt-0 flex gap-3">
            <input
              type="file"
              accept="video/*"
              className="hidden"
              ref={fileInputRef}
              onChange={(e) => {
                const file = e.target.files[0];
                if (file) handleStart('upload', file);
              }}
            />
            {sessionState === 'idle' || sessionState === 'ended' ? (
              <>
                <button
                  onClick={() => handleStart('live')}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
                >
                  <Video size={18} /> Start Inspection
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 bg-neutral-800 hover:bg-black text-white px-5 py-2.5 rounded-lg font-medium transition-colors border border-neutral-700"
                >
                  <Download size={18} className="rotate-180" /> Upload Video
                </button>
              </>
            ) : (
              <button
                onClick={handleStop}
                className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
              >
                <Square size={18} /> End {videoRef.current?.srcObject ? "Call" : "Analysis"}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-center gap-3">
            <XCircle size={20} /> {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Live Feed & AI Chat */}
          <div className="lg:col-span-2 space-y-4">

            {/* Viewfinder Container */}
            <div className="relative bg-black rounded-2xl overflow-hidden aspect-video shadow-md border border-neutral-200 flex items-center justify-center">
              {!streamRef.current && (
                <div className="text-neutral-500 flex flex-col items-center gap-2">
                  <Camera size={48} className="opacity-50" />
                  <p>Camera offline. Start inspection to begin.</p>
                </div>
              )}

              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${sessionState !== 'idle' ? 'opacity-100' : 'opacity-0'}`}
              />

              {/* Scanning Feedback Overlay */}
              {isScanning && (
                <div className="absolute inset-0 border-4 border-blue-500/50 pointer-events-none z-10 animate-pulse">
                  <div className="absolute top-0 left-0 right-0 h-1 bg-blue-500/50 animate-scanShadow"></div>
                </div>
              )}

              {/* Analysis Indicator Overlay */}
              {sessionState === 'active' && !videoRef.current?.srcObject && (
                <div className="absolute top-4 right-4 bg-black/60 backdrop-blur-md text-white text-[10px] font-mono px-3 py-1.5 rounded border border-white/10 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-ping"></div>
                  SEQUENTIAL FRAME EXTRACTION ACTIVE
                </div>
              )}

              {/* Status Pill */}
              {sessionState === 'active' && (
                <div className="absolute top-4 left-4 bg-red-500/90 backdrop-blur text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-2 font-medium tracking-wide shadow-sm animate-pulse">
                  <div className="w-2 h-2 bg-white rounded-full"></div> {videoRef.current?.srcObject ? "LIVE API ACTIVE" : "ANALYZING VIDEO"}
                </div>
              )}

              {/* AI Subtitles Overlay */}
              {sessionState !== 'idle' && (
                <div className="absolute bottom-6 left-0 right-0 flex justify-center px-4">
                  <div className="bg-neutral-900/80 backdrop-blur-md text-white px-6 py-3 rounded-xl max-w-xl text-center shadow-lg border border-white/10 transition-all duration-300 transform translate-y-0">
                    <p className="font-medium text-lg flex items-center gap-2 justify-center">
                      <Mic size={18} className="text-blue-400" />
                      {aiText}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Hidden Canvas for Frame Extraction */}
            <canvas ref={canvasRef} className="hidden" />

          </div>

          {/* Right Column: Findings & PDF Generation */}
          <div className="bg-white rounded-2xl shadow-sm border border-neutral-200 p-6 flex flex-col h-full">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <FileText className="text-neutral-500" />
                Live Damage Log
              </h2>
              <span className="bg-neutral-100 text-neutral-600 text-xs font-bold px-2 py-1 rounded-full">
                {snapshots.length} FOUND
              </span>
            </div>

            {/* Telemetry Panel */}
            {sessionState !== 'idle' && (
              <div className="mb-4 p-3 bg-neutral-900 rounded-xl text-[10px] font-mono text-neutral-400 border border-white/5 space-y-1">
                <div className="flex justify-between items-center">
                  <span>API STATUS</span>
                  <span className={telemetry.apiStatus === 'ACTIVE' ? 'text-green-400' : 'text-orange-400'}>{telemetry.apiStatus}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span>FRAMES PROCESSED</span>
                  <span className="text-white">{telemetry.framesSent}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span>LAST EXTRACTION</span>
                  <span className="text-white">{telemetry.lastFrameTime}</span>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto space-y-4 min-h-[300px] mb-4 pr-2">
              {snapshots.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-neutral-400 text-center px-4">
                  <AlertCircle size={32} className="mb-2 opacity-50" />
                  <p className="text-sm">No damage logged yet.<br />The AI will automatically capture evidence here.</p>
                </div>
              ) : (
                snapshots.map((snap) => (
                  <div key={snap.id} className="border border-neutral-200 rounded-xl overflow-hidden bg-neutral-50 flex animate-fade-in-up">
                    <img src={snap.image} alt="Damage" className="w-24 h-24 object-cover border-r border-neutral-200" />
                    <div className="p-3 flex flex-col justify-center">
                      <p className="font-bold text-sm text-neutral-900 flex items-center gap-1">
                        <CheckCircle size={14} className="text-green-600" /> {snap.classification}
                      </p>
                      <p className="text-xs text-neutral-500 mt-0.5">{snap.component}</p>
                      <p className="text-[10px] text-neutral-400 mt-1 line-clamp-2">{snap.description}</p>
                      <div className="mt-2 flex items-center gap-1">
                        <span className="text-[10px] font-bold tracking-wider text-orange-600 bg-orange-100 px-2 py-0.5 rounded uppercase">
                          Sev: {snap.severity}/10
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <button
              onClick={generatePDF}
              disabled={sessionState !== 'ended' && snapshots.length === 0}
              className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-colors ${sessionState !== 'ended' && snapshots.length === 0
                ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                : 'bg-neutral-900 hover:bg-black text-white shadow-md'
                }`}
            >
              <Download size={18} /> Generate PDF Report
            </button>
            <p className="text-center text-xs text-neutral-500 mt-3">
              Compiled securely via jsPDF directly in your browser.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
