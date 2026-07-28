Write-Host "=== Building admin-ui ==="
Set-Location admin-ui
npm install
npm run build
Set-Location ..

Write-Host "=== Building server (Windows) ==="
cargo build --release --target x86_64-pc-windows-msvc

Write-Host "=== Done ==="
Write-Host "Binary: target/x86_64-pc-windows-msvc/release/mini-ai-1c-server.exe"
