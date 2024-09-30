{
  description = "A nix development shell and build environment for penumbers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.rust-analyzer-src.follows = "";
    };
    crane = {
      url = "github:ipetkov/crane";
    };
  };

  outputs = { self, nixpkgs, flake-utils, crane, ... }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs { inherit system; };
          # Permit version declarations, but default to unset,
          # meaning the local working copy will be used.
          penumbersRelease = null;

          # Set up for Rust builds.
          craneLib = crane.mkLib pkgs;

          # Important environment variables so that the build can find the necessary libraries
          LIBCLANG_PATH="${pkgs.libclang.lib}/lib";
          ROCKSDB_LIB_DIR="${pkgs.rocksdb.out}/lib";
        in with pkgs; with pkgs.lib; let
          # All the Penumbra binaries
          penumbers = (craneLib.buildPackage {
            pname = "penumbers";
            # what
            src = cleanSourceWith {
              src = if penumbersRelease == null then craneLib.path ./. else fetchFromGitHub {
                owner = "penumbra-zone";
                repo = "penumbers";
                rev = "v${penumbersRelease.version}";
                sha256 = "${penumbersRelease.sha256}";
              };
              filter = path: type:
                # Retain non-rust files as build inputs:
                # * sql: database schema files for indexing
                # * html: templates for rendering web pages
                # * css: styles for rendering web pages
                # * woff2: fonts for rendering web pages
                (builtins.match ".*\.(sql|html|css|woff2)$" path != null) ||
                # ... as well as all the normal cargo source files:
                (craneLib.filterCargoSources path type);
            };
            nativeBuildInputs = [ pkg-config ];
            buildInputs = if stdenv.hostPlatform.isDarwin then 
              with pkgs.darwin.apple_sdk.frameworks; [clang openssl rocksdb SystemConfiguration CoreServices go]
            else
              [clang openssl rocksdb go];

            cargoExtraArgs = "-p penumbers";
            inherit system LIBCLANG_PATH ROCKSDB_LIB_DIR;
            meta = {
              description = "A web service for displaying metrics on Penumbra chains";
              homepage = "https://penumbra.zone";
              license = [ licenses.mit licenses.asl20 ];
            };
          }).overrideAttrs (_: { doCheck = false; }); # Disable tests to improve build times

        in rec {
          packages = { inherit penumbers ; };
          apps = {
            penumbers.type = "app";
            penumbers.program = "${penumbers}/bin/penumbers";
          };
          defaultPackage = symlinkJoin {
            name = "penumbers";
            paths = [ penumbers ];
          };
          devShells.default = craneLib.devShell {
            inherit LIBCLANG_PATH ROCKSDB_LIB_DIR;
            inputsFrom = [ penumbers ];
            packages = [
              cargo-nextest
              cargo-watch
              just
              nix-prefetch-scripts
              sqlfluff
            ];
            shellHook = ''
              export LIBCLANG_PATH=${LIBCLANG_PATH}
              export ROCKSDB_LIB_DIR=${ROCKSDB_LIB_DIR}
            '';
          };
        }
      );
}
