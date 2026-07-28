#!/bin/bash
set -e

echo "=== Building admin-ui ==="
cd admin-ui
npm install
npm run build
cd ..

echo "=== Building server (Linux) ==="
cargo build --release --target x86_64-unknown-linux-gnu

echo "=== Done ==="
echo "Binary: target/x86_64-unknown-linux-gnu/release/mini-ai-1c-server"
