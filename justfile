# A justfile for Penumbra "insights" dashboard development.
# Documents common tasks for local dev.

# install node deps locally via pnpm
install:
  pnpm install

# run the app locally with live reload, via pnpm
dev:
  @just install
  pnpm run dev

# build container image
container:
  podman build -f Containerfile -t penumbers .

# run container
run-container:
  just container
  podman run -e PENUMBRA_INDEXER_ENDPOINT -e PENUMBRA_INDEXER_CA_CERT -e COINGECKO_API_KEY -p 3000:3000 -it penumbers
