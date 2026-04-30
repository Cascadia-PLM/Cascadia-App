# Quickstart smoke test

Manual procedure for verifying the public demo flow (`docker-compose.demo.yml`)
end-to-end, on a clean Docker host with no clone of the repo.

Run this after any change to:

- `docker-compose.demo.yml`
- `docker/app.Dockerfile` / `workers/cad-converter/Dockerfile` / `workers/node/Dockerfile`
- `docker/demo-data.Dockerfile`
- `scripts/seed-demo-robot-arm.ts` (or anything seed-adjacent)
- `.github/workflows/publish-demo-images.yml`

Also run after the first publish to confirm GHCR package visibility is public.

## Setup

A clean Docker environment. Either:

- A fresh VM, or
- Your local Docker after `docker system prune -a --volumes` (warning: nukes
  all local images and volumes), or
- Run inside a container with Docker-in-Docker.

You should NOT have the Cascadia-App repo cloned on this machine. The whole
point is to verify the curl-and-go flow.

## Procedure

```bash
# 1. Fetch the compose file (verbatim from the README)
curl -O https://raw.githubusercontent.com/Cascadia-PLM/Cascadia-App/main/docker-compose.demo.yml

# 2. Bring up the stack, detached
docker compose -f docker-compose.demo.yml up -d

# 3. Watch the app boot. Expect:
#    - postgres and rabbitmq healthy within ~30s
#    - demo-data-loader exits with "demo data loaded" after ~5-10s
#    - app runs drizzle push, minimal seed, demo seed, then starts serving
#    - first-boot total: 60-180s before HTTP responds
docker compose -f docker-compose.demo.yml logs -f app
```

When `logs -f app` shows the server is listening, time it. Total wall time
from `up -d` to ready should be under 5 minutes on a typical home connection
(image pull dominates first run).

## Acceptance checks

Open <http://localhost:3000> and log in: `admin@cascadia.local` / `Cascadia`.

1. **Programs list**: ROBOT-ARM is visible.
2. **Design list under ROBOT-ARM**: TDJ-25 is visible.
3. **BOM tree** under TDJ-25: shows the main-assembly hierarchy with at least
   the BASE / SHOULDER / ELBOW / WRIST / EE sub-assemblies.
4. **Part detail for TDJ-25-A-00000-MAIN-ASSEMBLY**:
   - 3D viewer renders the colored model (yellow accents, black housing,
     blue/silver components — NOT a uniform gray).
   - File list shows both a `.glb` pill and a `.step` pill.
   - Thumbnail PNG renders in the part header.
5. **ECO**: "Initial Release - TDJ-25 Robot Arm" exists in Released state.

## Idempotency check

```bash
docker compose -f docker-compose.demo.yml restart app
docker compose -f docker-compose.demo.yml logs --tail=50 app
```

Should see "ROBOT-ARM program already exists, skipping demo seed" or similar
fast-path message; second boot should be ready within 30s.

## Reset check

```bash
docker compose -f docker-compose.demo.yml down -v
docker compose -f docker-compose.demo.yml up -d
```

Verify the second `up` re-pulls nothing (images cached) and re-seeds cleanly.
Same acceptance checks should pass.

## Failure triage

| Symptom | Likely cause |
|---|---|
| `unauthorized` on image pull | GHCR package visibility is still Private — flip to Public in org Packages settings |
| Viewer shows gray model | `cadMetadata.hasColors` not set — check the seed script in the published `cascadia-app` image is up to date |
| `demo-data-loader` keeps restarting | Wrong image tag, or `cascadia-demo-data` image has the wrong directory layout — should be `/demo-data/robot-arm/...` |
| App healthcheck fails before serving | Bump `start_period` further (currently 180s) if the host is slow on first-boot ingest |
| `STEP file pill` missing on a part | The `cascadia-demo-data` image was built without STEPs, or seed ingestion of STEP files failed silently |

## Cleanup

```bash
docker compose -f docker-compose.demo.yml down -v
rm docker-compose.demo.yml
docker image prune -a   # if you want to drop the pulled cascadia images
```
