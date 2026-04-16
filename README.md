# paperclip-session-api

Kleiner REST-Service vor der bestehenden Paperclip-Postgres-DB.

Zweck:
- Issues lesen
- neues Ticket mit bestehendem User-Session-Token anlegen
- Kommentar auf bestehendes Ticket schreiben

Wichtig:
- fuer Issue- und Kommentar-Erstellung mit Plugin-Events braucht der Service einen gueltigen Paperclip-Board/API-Token
- ohne `PAPERCLIP_API_KEY` faellt der Service auf die direkte DB-Schreibweise zurueck, dabei werden keine Plugin-Events im Hauptsystem ausgelöst
- wenn `PAPERCLIP_API_KEY` nicht gesetzt ist, liest der Service den Token automatisch aus `PAPERCLIP_AUTH_STORE` oder aus `${PAPERCLIP_HOME}/.paperclip/auth.json`
- die `board_api_keys`-Tabelle speichert den Secret-Token nicht, sondern nur Hash und Metadaten; fuer den Request-Header braucht die Session-API den Auth-Store oder `PAPERCLIP_API_KEY`
- Attachment-Uploads bleiben lokal und laufen nicht ueber die Paperclip-API
- auf dieser Box ist der systemd-Override auf `PAPERCLIP_HOME=/var/lib/paperclip` und `PAPERCLIP_AUTH_STORE=/var/lib/paperclip/.paperclip/auth.json` gesetzt

Auth:
- `Authorization: Session <token>`
- alternativ `X-Session-Token: <token>`

Endpunkte:
- `GET /healthz`
- `GET /v1/companies`
- `GET /v1/projects?companyId=<uuid>[&limit=<n>]`
- `GET /v1/projects/:projectId`
- `GET /v1/agents?companyId=<uuid>[&limit=<n>]`
- `GET /v1/issues?companyId=<uuid>[&status=<status>][&limit=<n>]`
- `GET /v1/issues/:issueRef`
- `GET /v1/issues/:issueRef/comments`
- `POST /v1/issues/archive`
- `PATCH /v1/issues/:issueRef`
- `POST /v1/issues`
- `POST /v1/issues/:issueRef/comments`

`issueRef` kann entweder die UUID des Issues oder der Identifier wie `SYN-19` sein.

## Start

```bash
export DATABASE_URL='postgresql://paperclip_app:...@127.0.0.1:5432/paperclip'
# optional, enables proxying issue/comment writes through Paperclip so plugin events fire
# if omitted, issue/comment writes still work but do not trigger the main app plugin bus
export PAPERCLIP_API_URL='http://127.0.0.1:3100'
export PAPERCLIP_API_KEY='pcp_board_...'
# optional override if your auth store lives elsewhere
# export PAPERCLIP_AUTH_STORE='/var/lib/paperclip/.paperclip/auth.json'
npm install
npm start
```

## Beispiel

```bash
curl 'https://your-host.example.com/session-api/v1/companies' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://your-host.example.com/session-api/v1/projects?companyId=00000000-0000-4000-8000-000000000001' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://your-host.example.com/session-api/v1/projects/00000000-0000-4000-8000-000000000002' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://your-host.example.com/session-api/v1/agents?companyId=00000000-0000-4000-8000-000000000001' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://your-host.example.com/session-api/v1/issues?companyId=00000000-0000-4000-8000-000000000001' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://your-host.example.com/session-api/v1/issues/SYN-19' \
  -H 'Authorization: Session <token>'
```

```bash
curl 'https://your-host.example.com/session-api/v1/issues/SYN-19/comments' \
  -H 'Authorization: Session <token>'
```

```bash
curl -X PATCH 'https://your-host.example.com/session-api/v1/issues/SYN-19' \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "todo"
  }'
```

```bash
curl -X POST 'https://your-host.example.com/session-api/v1/issues/archive' \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "companyId": "00000000-0000-4000-8000-000000000001",
    "status": "done",
    "before": "2026-04-01",
    "dryRun": true
  }'
```

```bash
curl -X POST http://127.0.0.1:4310/v1/issues \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "companyId": "00000000-0000-4000-8000-000000000001",
    "projectId": "00000000-0000-4000-8000-000000000002",
    "title": "API-Test",
    "description": "erstellt ueber den session service",
    "priority": "medium"
  }'
```

```bash
curl -X POST http://127.0.0.1:4310/v1/issues/SYN-19/comments \
  -H 'Authorization: Session <token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "body": "Kommentar ueber den session service"
  }'
```

## Reverse Proxy

Beispiel fuer Nginx:

```nginx
siehe `deploy/nginx.conf.example`
```

Hinweise:
- den Service nur hinter TLS exponieren
- Request-Body-Limits und Rate-Limits besser im Proxy erzwingen
- Session-Token nicht in URLs oder Query-Strings uebergeben
- fuer `systemd` gibt es `deploy/paperclip-session-api.service.example`
- `issueRef` akzeptiert UUID oder Identifier wie `SYN-19`
- `POST /v1/issues` verlangt jetzt immer ein gueltiges `projectId`, das zur angegebenen Company gehoert und fuer den User zugaenglich ist
- `PATCH /v1/issues/:issueRef` erlaubt: `status`, `title`, `description`, `priority`, `projectId`, `goalId`, `parentId`, `assigneeUserId`, `billingCode`, `hiddenAt`
- `POST /v1/issues/archive` archiviert alle nicht bereits versteckten Issues einer Company, die vor dem angegebenen Datum erstellt wurden und den angegebenen Status haben
- `before` kann ein ISO-Datum wie `2026-04-01` oder ein ISO-Datetime sein; Datum ohne Uhrzeit wird als lokaler Tagesanfang interpretiert
- `dryRun: true` liefert nur die Treffer zur Voransicht und aendert nichts
- wenn `PAPERCLIP_API_KEY` gesetzt ist, werden Issue- und Kommentar-Create-Requests an die bestehende Paperclip-API delegiert, damit dort die Plugin-Events ausgelöst werden
- wenn `PAPERCLIP_API_KEY` fehlt, bleibt die API funktional, aber Plugin-Events werden dann nicht erzeugt
