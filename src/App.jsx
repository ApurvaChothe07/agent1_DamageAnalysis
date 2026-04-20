import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, Mic, FileText, AlertCircle, Video, Square, Download, CheckCircle, XCircle } from 'lucide-react';

// The environment provides the API key at runtime.
const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

export default function App() {
  const [sessionState, setSessionState] = useState('idle'); // idle, connecting, active, ended
  const [inspectionStatus, setInspectionStatus] = useState("Waiting to start...");
  const [snapshots, setSnapshots] = useState([]);
  const [error, setError] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [telemetry, setTelemetry] = useState({ framesSent: 0, lastFrameTime: "None", apiStatus: "IDLE" });
  const lastAnalysisTimeRef = useRef(0);

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const videoIntervalRef = useRef(null);
  
  // Voice Analysis State
  const [recordingState, setRecordingState] = useState('idle');
  const [voiceData, setVoiceData] = useState(null);
  const [rawTranscript, setRawTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef(null);

  // Questionnaire State
  const [questionnaire, setQuestionnaire] = useState({
    date: new Date().toISOString().split('T')[0],
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    location: "Current Location",
    otherDetails: ""
  });

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
    setInspectionStatus(mode === 'live' ? "Requesting camera access..." : "Preparing video...");
    setSessionState('active');
    setTelemetry(prev => ({ ...prev, apiStatus: "ACTIVE" }));

    try {
      if (mode === 'live') {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 768 }, height: { ideal: 768 } }
        });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        
        // Auto-start microphone for hands-free claims
        startRecording();
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
                { text: "Analyze this frame for vehicle or property damage. Be precise but thorough—look for scratches, dents, cracks, or misalignment. Return a JSON object with: { damage_found: boolean, component: string, type: string, severity: number, description: string }. If you see damage, ensure damage_found is true. Only return JSON." },
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
          setInspectionStatus("AI system cooling down (rate limit)...");
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
          setInspectionStatus("Scanning... No new damage detected.");
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
    setInspectionStatus(`Detected: ${classification} on ${component}.`);
  };

  const handleStop = () => {
    stopAll();
    stopRecording();
    setSessionState('voice-claim');
    setInspectionStatus("Inspection paused. Please complete the Voice Claim and Questionnaire.");
  };

  const handleForceCapture = async () => {
    if (!canvasRef.current || !videoRef.current) return;
    
    setInspectionStatus("Capturing manual evidence...");
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = videoRef.current.videoWidth || 720;
    canvas.height = videoRef.current.videoHeight || 720;
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const base64Data = dataUrl.split(',')[1];

    try {
      setTelemetry(prev => ({ ...prev, apiStatus: "FORCING SCAN..." }));
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "Detailedly describe the vehicle damage in this specific frame. Return a JSON object with: { damage_found: true, component: string, type: string, severity: number, description: string }. This is a user-forced capture, so describe what is visible even if minor. Only return JSON." },
              { inline_data: { mime_type: "image/jpeg", data: base64Data } }
            ]
          }],
          generationConfig: { response_mime_type: "application/json" }
        })
      });

      const data = await response.json();
      const result = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
      
      handleManualCapture(
        result.component || "Manual Capture",
        result.type || "Visual Evidence",
        result.severity || 5,
        result.description || "Manual evidence logged by user.",
        dataUrl
      );
      setTelemetry(prev => ({ ...prev, apiStatus: "ACTIVE" }));
    } catch (err) {
      console.error("Force capture failed:", err);
      setInspectionStatus("Capture failed. Try again.");
    }
  };

  // --- VOICE ANALYSIS LOGIC (Browser STT) ---
  const startRecording = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = true;
    recognitionRef.current.lang = 'en-IN';

    recognitionRef.current.onstart = () => {
      setRecordingState('recording');
      setRawTranscript("");
      setInterimTranscript("");
    };

    recognitionRef.current.onresult = (event) => {
      let finalTranscript = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setRawTranscript(prev => prev + finalTranscript);
      setInterimTranscript(interim);
    };

    recognitionRef.current.onerror = (err) => {
      console.error("Speech Error:", err);
      setRecordingState('idle');
    };

    recognitionRef.current.onend = () => {
      if (recordingState === 'recording') setRecordingState('analyzing');
    };

    recognitionRef.current.start();
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setRecordingState('analyzing');
      analyzeTranscriptWithGemini(rawTranscript);
    }
  };

  const analyzeTranscriptWithGemini = async (text) => {
    const contentToAnalyze = text || rawTranscript;
    if (!contentToAnalyze || contentToAnalyze.length < 5) {
      setRecordingState('idle');
      return;
    }

    setInspectionStatus("Finalizing statement...");
    try {
      const fetchWithRetry = async (url, options, retries = 2, backoff = 2000) => {
        try {
          const res = await fetch(url, options);
          if (!res.ok && (res.status === 503 || res.status === 500) && retries > 0) {
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
              { text: `Extract data from: "${contentToAnalyze}". JSON format: incident_type, date_time, vehicle_involved, location, other_parties, damage_description, summary. ONLY JSON.` }
            ]
          }],
          generationConfig: { response_mime_type: "application/json" }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      const result = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
      
      setVoiceData(result);
      setRecordingState('idle');
      setInspectionStatus("Analysis complete.");
    } catch (err) {
      console.error(err);
      setRecordingState('idle');
    }
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

    // --- RE-IMPLEMENTING PREMIUM GREY BOX ---
    if (voiceData || rawTranscript || questionnaire.location !== "Current Location" || questionnaire.otherDetails) {
      doc.setFillColor(245, 247, 250);
      doc.rect(20, yOffset, pageWidth - 40, 85, 'F');
      
      doc.setFontSize(13);
      doc.setTextColor(40);
      doc.setFont(undefined, 'bold');
      doc.text("Incident Statement & Questionnaire", 25, yOffset + 12);
      
      doc.setFontSize(9);
      doc.setFont(undefined, 'normal');
      doc.setTextColor(60);
      doc.text(`Date: ${questionnaire.date}  |  Time: ${questionnaire.time}`, 25, yOffset + 22);
      doc.text(`Location: ${questionnaire.location}`, 25, yOffset + 28);
      
      doc.setFontSize(9);
      doc.setFont(undefined, 'italic');
      doc.setTextColor(110);
      const transcriptStr = rawTranscript || "No verbal statement recorded.";
      const transcriptLines = doc.splitTextToSize(`Voice Info: "${transcriptStr}"`, pageWidth - 50);
      doc.text(transcriptLines, 25, yOffset + 38);
      
      if (voiceData) {
        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(80);
        doc.text(`AI Summary: ${voiceData.summary || 'Summary pending.'}`, 25, yOffset + 60);
        
        if (voiceData.damage_description) {
          const vDamageLines = doc.splitTextToSize(`Reported Damage: ${voiceData.damage_description}`, pageWidth - 50);
          doc.text(vDamageLines, 25, yOffset + 68);
        }
      } else if (questionnaire.otherDetails) {
        const detailsLines = doc.splitTextToSize(`Additional Details: ${questionnaire.otherDetails}`, pageWidth - 50);
        doc.text(detailsLines, 25, yOffset + 60);
      }

      yOffset += 100;
    }

    doc.setFontSize(15);
    doc.setTextColor(40);
    doc.setFont(undefined, 'bold');
    doc.text("Visual Evidence Details", 20, yOffset);
    yOffset += 10;

    if (snapshots.length === 0) {
      doc.setFontSize(11);
      doc.setFont(undefined, 'italic');
      doc.setTextColor(120);
      doc.text("No visual damage was identified during this session.", 20, yOffset + 10);
    } else {
      snapshots.forEach((snap, index) => {
        if (yOffset > 210) { doc.addPage(); yOffset = 20; }
        
        doc.setFontSize(13);
        doc.setTextColor(40);
        doc.setFont(undefined, 'bold');
        doc.text(`Finding ${index + 1}: ${snap.component} - ${snap.classification}`, 20, yOffset);
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'italic');
        doc.setTextColor(80);
        const descriptionLines = doc.splitTextToSize(snap.description, pageWidth - 40);
        doc.text(descriptionLines, 20, yOffset + 8);
        
        const descriptionHeight = (descriptionLines.length * 5) + 5;
        const severityY = yOffset + 8 + descriptionHeight;

        doc.setFontSize(9);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(120);
        doc.text(`Severity: ${snap.severity}/10  |  Time logged: ${snap.timestamp}`, 20, severityY);

        doc.addImage(snap.image, 'JPEG', 20, severityY + 8, 140, 105);
        yOffset = severityY + 120;
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

            {sessionState === 'active' && (
              <button
                onClick={handleForceCapture}
                className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
              >
                <Camera size={18} /> Log Damage
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

              {/* AI Subtitles & Live Transcript Overlay */}
              {sessionState !== 'idle' && (
                <div className="absolute bottom-6 left-0 right-0 flex flex-col items-center gap-3 px-4 z-20">
                  {/* Active Speech Overlay */}
                  {(interimTranscript || rawTranscript) && recordingState === 'recording' && (
                    <div className="bg-blue-600/90 backdrop-blur-md text-white px-4 py-2 rounded-lg shadow-lg border border-white/20 animate-pulse flex items-center gap-2 max-w-lg">
                      <Mic size={14} className="text-blue-100" />
                      <p className="text-sm font-medium italic">
                        {interimTranscript || "..."}
                      </p>
                    </div>
                  )}

                  {/* Scan Status Overlay */}
                  <div className="bg-neutral-900/80 backdrop-blur-md text-white px-6 py-3 rounded-xl max-w-xl text-center shadow-lg border border-white/10 transition-all">
                    <p className="font-medium text-lg flex items-center gap-2 justify-center">
                      <Camera size={18} className="text-blue-400" />
                      {inspectionStatus}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Hidden Canvas for Frame Extraction */}
            <canvas ref={canvasRef} className="hidden" />

            {/* Voice Claim & Questionnaire Modal Step */}
            {sessionState === 'voice-claim' && (
              <div className="bg-white rounded-2xl shadow-xl border border-blue-100 p-8 animate-fade-in relative z-50">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-2xl font-bold text-neutral-900 flex items-center gap-2">
                    <Mic className="text-blue-600" />
                    Voice Claim & Questionnaire
                  </h2>
                  <div className="bg-blue-50 text-blue-600 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                    Step 2 of 2
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1">When did the accident happen?</label>
                      <input 
                        type="date" 
                        value={questionnaire.date}
                        onChange={(e) => setQuestionnaire({...questionnaire, date: e.target.value})}
                        className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1">Incident Time</label>
                      <input 
                        type="time" 
                        value={questionnaire.time}
                        onChange={(e) => setQuestionnaire({...questionnaire, time: e.target.value})}
                        className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1">Incident Location</label>
                      <input 
                        type="text" 
                        placeholder="e.g. MG Road, Mumbai"
                        value={questionnaire.location}
                        onChange={(e) => setQuestionnaire({...questionnaire, location: e.target.value})}
                        className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1">Additional Details</label>
                      <textarea 
                        placeholder="Any other parties involved?"
                        value={questionnaire.otherDetails}
                        onChange={(e) => setQuestionnaire({...questionnaire, otherDetails: e.target.value})}
                        className="w-full bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-blue-500 outline-none transition-all h-[42px]"
                      ></textarea>
                    </div>
                  </div>
                </div>

                <div className="bg-neutral-900 rounded-2xl p-6 mb-8">
                  <div className="flex flex-col items-center justify-center space-y-4">
                    <p className="text-neutral-400 text-sm font-medium">Record your verbal statement explaining the incident</p>
                    
                    <button
                      onClick={recordingState === 'recording' ? stopRecording : startRecording}
                      disabled={recordingState === 'analyzing'}
                      className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${
                        recordingState === 'recording' 
                        ? 'bg-red-500 animate-pulse text-white shadow-[0_0_20px_rgba(239,68,68,0.5)]' 
                        : 'bg-white text-neutral-900 hover:scale-105'
                      }`}
                    >
                      {recordingState === 'recording' ? <Square size={32} /> : <Mic size={32} className={recordingState === 'analyzing' ? 'animate-spin' : ''} />}
                    </button>

                    <p className={`text-lg font-bold tracking-tight ${recordingState === 'recording' ? 'text-red-400' : 'text-white'}`}>
                      {recordingState === 'recording' ? 'LISTENING...' : recordingState === 'analyzing' ? 'ANALYZING VOICE...' : 'TAP TO RECORD'}
                    </p>

                    {(interimTranscript || rawTranscript) && (
                      <div className="w-full max-w-lg p-4 bg-white/5 border border-white/10 rounded-xl">
                        <p className="text-blue-400 text-xs font-bold uppercase mb-2">Live Transcript</p>
                        <p className="text-white text-sm italic leading-relaxed">
                          {interimTranscript || rawTranscript || "Speak now..."}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => {
                        setSessionState('ended');
                        setInspectionStatus("Inspection finalized.");
                    }}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-bold transition-all shadow-lg hover:shadow-blue-500/20"
                  >
                    Finish & View Report
                  </button>
                </div>
              </div>
            )}

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

            {/* Voice Data Display */}
            {(voiceData || rawTranscript) && (
              <div className="mb-6 p-4 bg-blue-50 border border-blue-100 rounded-xl animate-fade-in">
                <h3 className="text-sm font-bold text-blue-900 mb-2 flex items-center gap-2">
                  <Mic size={16} /> Incident Context
                </h3>
                <div className="space-y-3">
                  {rawTranscript && (
                    <div className="p-2 bg-blue-100/50 rounded italic text-xs text-blue-700">
                      "{rawTranscript}"
                    </div>
                  )}
                  {voiceData && (
                    <>
                      <p className="text-xs text-blue-800 leading-relaxed">
                        <span className="font-bold">AI Analysis:</span> {voiceData.summary}
                      </p>
                      {voiceData.damage_description && (
                        <p className="text-xs text-blue-700 mt-1 italic">
                          <span className="font-bold not-italic">Verbal Damage:</span> {voiceData.damage_description}
                        </p>
                      )}
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div className="bg-white/50 p-2 rounded border border-blue-100">
                          <p className="text-[10px] text-blue-400 uppercase font-bold">Location</p>
                          <p className="text-xs font-medium text-blue-900">{voiceData.location}</p>
                        </div>
                        <div className="bg-white/50 p-2 rounded border border-blue-100">
                          <p className="text-[10px] text-blue-400 uppercase font-bold">Vehicle</p>
                          <p className="text-xs font-medium text-blue-900">{voiceData.vehicle_involved || "Generic"}</p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={generatePDF}
              disabled={(sessionState !== 'ended' && sessionState !== 'voice-claim') && snapshots.length === 0}
              className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium transition-colors ${(sessionState !== 'ended' && sessionState !== 'voice-claim') && snapshots.length === 0
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
