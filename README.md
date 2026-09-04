# NowRanks

NowRanks is the foundation for a future web application that will track Google search rankings for important keywords over time.

## Stack

- React and TypeScript for the web interface
- Vite for local development and production builds
- Vitest and Testing Library for component tests

## Getting started

From `C:\NowRanks`, install dependencies:

```powershell
npm install
```

Start the development server:

```powershell
npm run dev
```

Build the application for production:

```powershell
npm run build
```

Run the test suite:

```powershell
npm test
```

## Development scoring diagnostics

While running the Vite development server, append `?scoringDiagnostics=1` to the dashboard URL. The browser developer console will print one row per ranked candidate with every normalized component, configured weight, weighted contribution, and final score. This mode is guarded by Vite's development flag and does not run in production builds.

The current Google inputs are local Trending Now and historical-interest replay fixtures. Diagnostics label them as replay/fixture-derived values; they are not live Google measurements.

## Feature-flagged persisted-live UI

Replay remains the default. To inspect the persisted-live UI in Git Bash, start the read-only live API in one terminal:

```bash
LEADERBOARD_DATA_SOURCE=live npm run api:dev
```

Then start Vite in a second terminal:

```bash
VITE_LEADERBOARD_DATA_SOURCE=live VITE_USE_LEADERBOARD_API=true npm run dev
```

The live UI reads only the API's persisted snapshot: Overall shows Established entries only, while Trending displays separate Established Trending and Emerging lanes. Browsing this path does not trigger ingestion, provider requests, or writes. In PowerShell, set each variable with `$env:NAME = 'value'` before the corresponding command.

## Project structure

```text
src/
  app/       Application shell and page-level UI
  features/  Future product areas, such as keywords and categories
  server/    Future API, database, authentication, and subscription code
  styles/    Shared CSS
  test/      Test setup
```

No ranking collection, third-party services, authentication, payments, or database integration are included yet.
