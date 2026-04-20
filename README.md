# Agent1 Damage Analysis 🚗🔍

Real-time autonomous vehicle and property damage assessment driven by Google Gemini 1.5 Flash. This application provides a seamless, zero-backend flow for identifying damage from live video feeds or uploads and generating professional PDF reports instantly.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/React-19-blue)
![Vite](https://img.shields.io/badge/Vite-8-purple)

## ✨ Features

- **Real-Time Analysis**: Stream live video from your camera and get instant AI feedback on detected damage.
- **Smart Detection**: Utilizes Gemini 1.5 Flash to classify damage types (dents, scratches, cracks), identify affected components, and estimate severity.
- **Video Upload**: Analyze pre-recorded footage with the same high-precision detection.
- **Instant Reporting**: Generate and download comprehensive PDF reports including timestamps, descriptions, and captured snapshots.
- **Privacy First**: All PDF generation happens client-side using `jsPDF`.
- **Responsive Design**: Premium Glassmorphism UI built with Tailwind CSS and Framer Motion.

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- A Google Gemini API Key ([Get one here](https://aistudio.google.com/))

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/agent1-damage-analysis.git
   cd agent1-damage-analysis
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   Create a `.env` file in the root directory (or rename `.env.example`):
   ```bash
   cp .env.example .env
   ```
   Add your API key to the `.env` file:
   ```env
   VITE_GEMINI_API_KEY=your_actual_api_key_here
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```

## 🛠️ Tech Stack

- **Frontend**: React 19, Vite
- **Styling**: Tailwind CSS
- **AI Model**: Google Gemini 1.5 Flash
- **Icons**: Lucide React
- **Animations**: Framer Motion
- **PDF Generation**: jsPDF

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
