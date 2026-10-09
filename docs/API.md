# CloudSkill Hub API

All `/api/*` except `/api/bootstrap` require `Authorization: Bearer csh_xxx`.
All response bodies use JSON except ZIP downloads. Never put tokens in URLs.

| Method | Endpoint | Permission | Description |
|---|---|---|---|
| GET | `/healthz` | public | Health |
| POST | `/api/bootstrap` | one-time secret | Issue first admin token |
| GET | `/api/me` | client/admin | Current identity |
| GET | `/api/projects` | client/admin | Authorized projects |
| POST | `/api/projects` | admin | Create project `{slug,title}` |
| GET | `/api/catalog` | client/admin | Authorized latest skill metadata |
| POST | `/api/projects/{project}/skills/{skill}` | admin | Publish `{files:{path:base64},visibility}` |
| GET | `/api/projects/{project}/skills/{skill}/versions` | client/admin | Version history |
| GET | `/api/projects/{project}/skills/{skill}/versions/{version}` | client/admin | Immutable file bundle |
| GET | `/api/projects/{project}/skills/{skill}/download` | client/admin | Latest deterministic ZIP |
| POST | `/api/projects/{project}/skills/{skill}/rollback` | admin | `{version}` creates new version |
| GET | `/api/tokens` | admin | Token metadata only |
| POST | `/api/tokens` | admin | Issue client/admin token `{label,role,projects}` |
| POST | `/api/tokens/{id}/revoke` | admin | Revoke another token |
| GET | `/api/devices` | admin | Last reported device inventories |
| POST | `/api/devices/heartbeat` | client/admin | Device status |
| GET | `/api/audit` | admin | Recent actions |
| GET | `/.well-known/skills/index.json` | public | Public Agent Skills listing |
| GET | `/.well-known/skills/{skill}/{path}` | public | Public Skill file |
| GET | `/.well-known/agent-skills/index.json` | public | ZIP-oriented discovery 0.2 |

## Publication payload

```json
{
  "files": {"SKILL.md": "LS0t...", "references/example.md":"IyBFeGFtcGxl"},
  "visibility": "private"
}
```

The server validates the `SKILL.md` frontmatter name to match the API path. `description` is required, and other frontmatter fields are preserved verbatim.

## Token scope

- `admin`: full access and publishing.
- `client`: read only, **at least one** project must be granted.
- Public well-known discovery only includes explicitly public skills. A private Skill is never listed anonymously.

## Error format

```json
{ "error": "Invalid or revoked token" }
```

Typical HTTP statuses: `400` invalid payload, `401` missing/invalid token, `403` unauthorized, `404` missing, `409` version/uniqueness conflict, `413` payload too large, `503` missing backend artifact.
