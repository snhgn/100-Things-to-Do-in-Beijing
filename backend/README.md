# Backend API for Cloud Sync

This backend matches the frontend contract in this repository:
- GET /health
- GET /attraction-databases?user_id=<string>&db_slot=<1..10>
- PUT /attraction-databases

## 1) Install

1. Open terminal in backend folder.
2. Run:

npm install

## 2) Configure environment variables

1. Copy .env.example to .env.
2. Fill PostgreSQL connection info from Azure PostgreSQL Flexible Server.
3. Set API_KEY to a random string (recommended).
4. Set CORS_ALLOWED_ORIGIN to your frontend domain.

## 3) Start locally

npm start

Server starts on PORT (default 3000).

## 4) Quick local test

Health check:

GET http://localhost:3000/health

Read payload:

GET http://localhost:3000/attraction-databases?user_id=test-user&db_slot=1
Header: Authorization: Bearer <API_KEY>

Write payload:

PUT http://localhost:3000/attraction-databases
Header: Content-Type: application/json
Header: Authorization: Bearer <API_KEY>
Body:
{
  "user_id": "test-user",
  "db_slot": 1,
  "payload": []
}

## 5) Deploy to Azure App Service (Node.js)

1. Create a Web App (Runtime: Node.js 20).
2. Deploy backend folder as your app code.
3. In App Service > Configuration, add all env vars from .env.example.
4. Restart app.
5. Verify https://<your-app>.azurewebsites.net/health.

## 6) Connect frontend

In index.html, set:
- apiBaseUrl: https://<your-app>.azurewebsites.net
- apiKey: same as backend API_KEY
- userId: optional (empty is fine)

Then refresh frontend page and check the top-right cloud status.
