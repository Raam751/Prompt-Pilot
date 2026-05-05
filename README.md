# AI Agent CLI Tool - Scaler Clone Generator

A conversational CLI agent that accepts natural language instructions and iteratively generates a Scaler Academy-like landing page (`header`, `hero`, `footer`) as real files:

- `index.html`
- `styles.css`
- `script.js`

The agent follows a step-by-step loop (`START -> THINK -> TOOL -> OBSERVE -> ... -> OUTPUT`) rather than finishing in one shot.

## Features

- Interactive terminal chat loop
- JSON-based reasoning protocol
- Tool-based execution (create folder, write/read files, list files, run commands)
- Frontend generation using Groq model (`llama-3.3-70b-versatile` by default)
- Output files are browser-ready and saved under `generated_sites/`
- Ready for static deployment on Vercel

## Project Structure

```text
.
├── src/
│   └── index.js
├── generated_sites/      # created at runtime
├── .env.example
├── package.json
├── vercel.json
└── README.md
```

## Prerequisites

- Node.js 18+
- Groq API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env`:

```bash
cp .env.example .env
```

3. Add your Groq key to `.env`:

```env
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
```

## Run (CLI)

```bash
npm start
```

Example prompt to paste into CLI:

```text
Create a folder named scaler_clone and clone the Scaler Academy homepage hero experience using HTML, CSS, and JS. Must include header, hero section, and footer.
```

The generated files will appear inside:

```text
generated_sites/scaler_clone/
```

Open in browser:

```bash
open generated_sites/scaler_clone/index.html
```

## Run (Web Frontend)

The project now includes a web frontend:

- `index.html` (UI)
- `styles.css` (dashboard styles)
- `app.js` (frontend logic)
- `api/chat.js` (Vercel serverless function with Groq)

Use local Vercel dev server:

```bash
npx vercel dev
```

Then open:

```text
http://localhost:3000
```

Enter a prompt in the UI, run agent, and preview generated website directly.

## Vercel Deployment

You can deploy either from dashboard or CLI.

### Option A: Vercel Dashboard

1. Push this repo to GitHub.
2. Go to [Vercel](https://vercel.com/new).
3. Import the GitHub repository.
4. Framework preset: `Other`.
5. Keep defaults and deploy.

For this web app deployment, keep repository root as the default Root Directory.

### Option B: Vercel CLI

```bash
npm i -g vercel
vercel login
vercel
vercel --prod
```

When asked for root directory, choose `.` (repository root).

## Demo Video Checklist (2-3 minutes)

Record these in order:

1. Show `npm start`
2. Enter a natural-language instruction in terminal
3. Show step-by-step loop output (`START/THINK/TOOL/OBSERVE/OUTPUT`)
4. Open generated `index.html` in browser
5. Show deployed Vercel URL

## Notes

- The agent supports extra tools (`weather`, `github lookup`, `execute command`) but the core grading target is website generation with reasoning loop.
- All generated content is editable after creation.
