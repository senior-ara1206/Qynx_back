# JSON Auth Server

Simple Express server that stores all users in `auth.json`.

## Install

```bash
npm install
```

## Run

```bash
npm start
# or for development with auto-reload
npm run dev
```

## API

- POST `/api/register`  { name, email, password } -> 201 created
- POST `/api/login`     { email, password } -> 200 with user
- GET `/api/users`      -> list users (no passwords)
- GET `/api/users/:id`  -> single user
- PUT `/api/users/:id`  { name?, email?, password? } -> update
- DELETE `/api/users/:id` -> delete

All data is persisted to `auth.json` in the project root.

## Example curl

Register:

```bash
curl -X POST http://localhost:3000/api/register -H "Content-Type: application/json" -d '{"name":"Alice","email":"alice@example.com","password":"pass123"}'
```

Login:

```bash
curl -X POST http://localhost:3000/api/login -H "Content-Type: application/json" -d '{"email":"alice@example.com","password":"pass123"}'
```
