# Roam Backend API

The Roam backend is an Express/MongoDB service that acts as a secure proxy between the Chrome extension and external APIs (Gemini, Skyscanner, Power BI). It ensures that no API keys are exposed to the client and securely synchronizes user engagement data.

## Environment Variables

Copy `.env.example` to `.env` and fill in the required keys.

```bash
# Required
GEMINI_API_KEY="AIza..."
SKYSCANNER_API_KEY="..."
MONGODB_URI="mongodb+srv://..."

# Optional 
PORT=3000
GEMINI_MODEL="gemma-3-27b-it"

# Power BI Streaming (V5 Feature)
POWER_BI_EVENTS_URL="https://api.powerbi.com/beta/..."
POWER_BI_SCORES_URL="https://api.powerbi.com/beta/..."
```

## Endpoints

### `POST /detect`
- **Purpose**: Proxies detection payload (text + screenshot) to the Gemini API.
- **Headers**: `x-device-id` (Required)
- **Body**: `{ text: string, screenshot?: string, postId: string, platform: 'instagram' | 'tiktok' }`
- **Response**: `{ isTravel: boolean, destinations: [...] }`

### `POST /flights`
- **Purpose**: Proxies live flight search to Skyscanner and polls for completion.
- **Headers**: `x-device-id` (Required)
- **Body**: `{ iataCode: string, homeAirport: string, currency: string, maxPolls: number }`
- **Response**: Flight data object or `null`.

### `POST /events`
- **Purpose**: Saves engagement events to MongoDB and streams them to Power BI.
- **Headers**: `x-device-id` (Required)
- **Body**: `{ events: EngagementEvent[] }`
- **Response**: `{ success: true, inserted: number }`

### `POST /scores`
- **Purpose**: Upserts recalculated intent scores to MongoDB and streams them to Power BI.
- **Headers**: `x-device-id` (Required)
- **Body**: `{ scores: InterestScore[] }`
- **Response**: `{ success: true, updated: number }`

### `GET /scores`
- **Purpose**: Retrieves a device's saved intent scores for cross-device sync.
- **Headers**: `x-device-id` (Required)
- **Response**: `{ scores: InterestScore[], lastUpdated: number }`

### `POST /summary`
- **Purpose**: Requests a natural language intent summary from Gemini.
- **Headers**: `x-device-id` (Required)
- **Body**: `{ prompt: string, maxTokens?: number, temperature?: number }`

## Hosting on Railway

The backend is configured to be easily hosted on [Railway.app](https://railway.app/).

### Steps to Deploy:
1. Push this repository to GitHub.
2. In Railway, create a new project from your GitHub repo.
3. Configure the Root Directory of the deployment to `/backend`.
4. Add the following **Environment Variables** in the Railway dashboard:
   - `GEMINI_API_KEY`
   - `SKYSCANNER_API_KEY`
   - `MONGODB_URI`
   - `POWER_BI_EVENTS_URL` (optional)
   - `POWER_BI_SCORES_URL` (optional)
5. Generate a domain in Railway (e.g., `roam-production.up.railway.app`).
6. Update `CONFIG.BACKEND_URL` in `extension/src/config.ts` to your new Railway URL and rebuild the extension.
