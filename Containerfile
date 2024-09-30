FROM docker.io/rust:1-slim-bookworm AS build-env

# Install build dependencies. These packages should match what's recommended on
# https://guide.penumbra.zone/dev/build
RUN apt-get update && apt-get install -y \
        build-essential \
        pkg-config \
        libssl-dev \
        clang

# Build rust code
WORKDIR /usr/src/penumbra
COPY . .
RUN cargo build --release

# Runtime image.
FROM docker.io/debian:bookworm-slim
ARG USERNAME=penumbra
ARG UID=1000
ARG GID=1000

# Add normal user account
RUN groupadd --gid ${GID} ${USERNAME} \
        && useradd -m -d /home/${USERNAME} -g ${GID} -u ${UID} ${USERNAME}

# Install chain binaries
COPY --from=build-env /usr/src/penumbra/target/release/penumbers /usr/bin/penumbers

WORKDIR /home/${USERNAME}
USER ${USERNAME}
# See `--help` info for required database arguments to run `penumbers`.
CMD [ "/usr/bin/penumbers" ]
