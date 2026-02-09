# CLI Team Bridge Security Documentation

**Version:** 0.1.0  
**Last Updated:** 2026-02-09

---

## 1. Threat Model Overview

### 1.1 Same-User Process Threat (Primary Concern)

The most relevant threat model for cli-team-bridge is **same-user process compromise**. Any process running as the same OS user can:

- Read/modify the `.claude/bridge` directory
- Inject, replay, or delete messages
- Spoof agent registry entries
- Intercept MCP/ACP communications

**Mitigation:** File permissions (0700) on `.claude/bridge` and atomic write operations.

### 1.2 Different-User Threat

Mitigated by standard Unix directory permissions:
- `.claude/bridge` is created with `0700` permissions
- No group/world read access
- Assumes no overly-permissive parent directories

### 1.3 Agent Compromise Scenarios

If an agent executable is compromised:
- **Current:** Agent runs with full user privileges
- **Impact:** Can access any file the user can access
- **Limitations:** Environment variable filtering, path traversal protection, permission controls

---

## 2. Filesystem IPC Security (.claude/bridge)

### 2.1 Directory Structure

```
.claude/bridge/
├── agents.json          # Agent registry (atomic writes)
├── messages/
│   ├── agent-a/         # Per-agent inbox
│   ├── agent-b/
│   └── ...
└── requests/            # Open request queue
```

### 2.2 Permission Requirements

- **Directory:** `0700` (owner read/write/execute only)
- **Files:** `0600` (owner read/write only)
- **Created by:** Bridge on startup with restrictive permissions

### 2.3 Risks

| Risk | Description | Impact |
|------|-------------|--------|
| Message Injection | Malicious process writes fake messages | Agents receive spoofed commands |
| Replay Attack | Old messages re-delivered | Duplicate actions |
| Message Deletion | Legitimate messages removed | Lost coordination |
| Registry Spoofing | Fake agent entries | Impersonation |

### 2.4 Mitigations

- **Atomic Writes:** All file writes use temp-file + fsync + rename pattern
- **Lock Discipline:** Registry operations are serialized
- **Replay Protection:** Message timestamps with acceptance windows
- **Integrity:** JSON parsing with validation, corrupted files skipped with warnings

---

## 3. Agent Process Security

### 3.1 Current Limitations

**No Sandboxing:** Agents run as normal child processes with:
- Full filesystem access
- Full network access
- Same user privileges as parent

### 3.2 Environment Variable Filtering

```typescript
// Allowed environment variables (strict allowlist)
const ALLOWED_ENV = [
  'PATH', 'HOME', 'SHELL', 'TERM', 'LANG',
  'NODE_ENV', 'TMPDIR', 'TEMP', 'TMP'
]
```

- No API keys passed directly (agents use their own OAuth)
- No cloud credentials inherited
- Minimal attack surface

### 3.3 Path Traversal Protection

```typescript
// Project path validation
const resolvedPath = resolve(workspaceRoot, requestedPath)
if (!resolvedPath.startsWith(workspaceRoot + sep)) {
  throw new Error('Path traversal detected')
}
```

- All project paths resolved against configured `workspaceRoot`
- `../..` traversal blocked
- Absolute paths outside workspace rejected

### 3.4 Permission Controls

**Permission Policy Engine** (`src/permission-policy.ts`):

| Action | Examples |
|--------|----------|
| **DENY** | `git push --force`, `rm -rf`, `DROP TABLE`, `shutdown` |
| **ALLOW** | `git status`, `Read`, `Write` (scoped to project) |
| **ASK** | `Bash`, `FetchURL`, `WebSearch` (logged for audit) |

**Path-based Scoping:**
- Blocked: `.env`, `.ssh/`, `.aws/`, secrets, keys
- Allowed: Project directory only

---

## 4. Transport Security

### 4.1 MCP (Model Context Protocol)

- **Transport:** JSON-RPC over stdio
- **Trust Model:** Implicit trust of parent process
- **Authentication:** None (local only)
- **Authorization:** Tool-level permission controls

### 4.2 ACP (Agent Client Protocol)

- **Transport:** NDJSON over stdio
- **Trust Model:** Bridge spawns and controls agent processes
- **Authentication:** OAuth via agent CLI (external to bridge)
- **Authorization:** Permission policy engine

### 4.3 Future Considerations

If transport evolves to HTTP/WebSocket:
- Implement client authentication
- Add request signing
- Use TLS for encryption
- Add rate limiting

---

## 5. Recommendations

### 5.1 For Operators

**Production Deployment:**
1. Run bridge in container with minimal privileges
2. Mount workspace as read-only where possible
3. Use dedicated service account (not personal user)
4. Enable audit logging
5. Monitor metrics (`get_metrics` MCP tool)
6. Set `messaging.failSilently: false` for strict mode

**Configuration:**
```json
{
  "messaging": {
    "enabled": true,
    "failSilently": false
  },
  "permissions": {
    "autoApprove": false
  }
}
```

### 5.2 For Developers

**Extending the Bridge:**
1. Use `permission-policy.ts` for new tool integrations
2. Add metrics for new failure modes
3. Validate all paths with `isPathAllowed()`
4. Use atomic writes for all file operations
5. Never pass secrets through environment variables

**Security Checklist:**
- [ ] Path traversal validation on all file operations
- [ ] Permission check before destructive operations
- [ ] Error handling that doesn't leak sensitive info
- [ ] Metrics for security-relevant events
- [ ] Audit logging for permission decisions

### 5.3 Security Hardening Checklist

**Immediate (Layer 1):**
- [x] Environment variable allowlist
- [x] Path traversal protection
- [x] Permission policy engine
- [x] Atomic file writes
- [x] Error propagation (no silent failures)

**Short-term (Layer 2):**
- [ ] Container-based agent isolation
- [ ] Network namespace restrictions
- [ ] Resource limits (CPU, memory, disk)
- [ ] Audit logging to external system

**Long-term (Layer 3):**
- [ ] Full sandboxing (bubblewrap/Docker)
- [ ] Capability dropping
- [ ] Seccomp profiles
- [ ] User namespace isolation

---

## 6. Incident Response

### 6.1 Detecting Compromise

Monitor for:
- Unexpected agent registrations
- High permission denial rates
- Unusual file access patterns
- Message bus errors

### 6.2 Response Steps

1. **Immediate:** Stop bridge (`SIGTERM`)
2. **Assess:** Check `.claude/bridge` for unauthorized changes
3. **Clean:** Clear agent registry, message queues
4. **Restart:** With increased logging
5. **Review:** Audit logs for attack vector

---

## 7. References

- [MCP Specification](https://modelcontextprotocol.io/)
- [ACP Specification](https://github.com/zed-industries/agent-client-protocol)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [Linux Capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html)

---

**Questions or security concerns?**  
Open an issue on GitHub: https://github.com/Holovkat/cli-team-bridge/issues
