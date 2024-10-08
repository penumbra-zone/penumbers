# A justfile for dex-explorer development.
# Documents common tasks for local dev.

# run the app locally with live reload, via pnpm
dev:
  pnpm install
  pnpm dev

# build container image
container:
  podman build -f Containerfile -t p3numb3rs .

# run container
run-container:
  just container
  podman run -e PENUMBRA_INDEXER_ENDPOINT -e PENUMBRA_INDEXER_CA_CERT -p 3000:3000 -it p3numb3rs
