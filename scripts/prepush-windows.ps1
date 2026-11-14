$ErrorActionPreference = "Stop"

$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repositoryRoot

function Refresh-ProcessPath {
    $paths = @(
        [Environment]::GetEnvironmentVariable("Path", "Machine"),
        [Environment]::GetEnvironmentVariable("Path", "User"),
        $env:Path
    ) | Where-Object { $_ } | ForEach-Object { $_ -split ";" } |
        Where-Object { $_ } | Select-Object -Unique

    $env:Path = $paths -join ";"
}

function Ensure-WingetTool {
    param(
        [string]$PackageId,
        [string]$CommandName
    )

    if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
        Write-Host "$CommandName is already available."
        return
    }

    $installedPackages = & winget list --id $PackageId --exact --accept-source-agreements 2>&1 |
        Out-String

    if ($installedPackages -notmatch [regex]::Escape($PackageId)) {
        Write-Host "Installing $PackageId..."
        & winget install --id $PackageId --exact `
            --accept-source-agreements --accept-package-agreements

        if ($LASTEXITCODE -ne 0) {
            throw "Installation failed for $PackageId (exit code $LASTEXITCODE)."
        }
    } else {
        Write-Host "$PackageId is already installed."
    }

    Refresh-ProcessPath

    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "$PackageId is installed, but '$CommandName' is not on PATH. Repair the installation and rerun this script."
    }
}

function Import-BatchEnvironment {
    param([string]$BatchFile)

    $command = 'call "' + $BatchFile + '" && set'
    $environment = & $env:ComSpec /d /c $command

    if ($LASTEXITCODE -ne 0) {
        throw "Could not load the environment from $BatchFile."
    }

    foreach ($line in $environment) {
        $separator = $line.IndexOf("=")
        if ($separator -le 0) {
            continue
        }

        $name = $line.Substring(0, $separator)
        if ($name -match "^[A-Za-z_][A-Za-z0-9_]*$") {
            [Environment]::SetEnvironmentVariable(
                $name,
                $line.Substring($separator + 1),
                "Process"
            )
        }
    }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Windows Package Manager (winget) is required to install missing tools."
}

Ensure-WingetTool -PackageId "OpenJS.NodeJS.LTS" -CommandName "node"
Ensure-WingetTool -PackageId "Kitware.CMake" -CommandName "cmake"
Ensure-WingetTool -PackageId "Ninja-build.Ninja" -CommandName "ninja"
Ensure-WingetTool -PackageId "Python.Python.3.12" -CommandName "python"
Ensure-WingetTool -PackageId "Git.Git" -CommandName "git"

$emsdkRoot = Join-Path $env:USERPROFILE "emsdk"
$emsdkBatch = Join-Path $emsdkRoot "emsdk.bat"

if (-not (Test-Path $emsdkBatch)) {
    if (Test-Path $emsdkRoot) {
        throw "The Emscripten SDK directory exists but emsdk.bat was not found: $emsdkRoot"
    }

    Write-Host "Downloading the official Emscripten SDK..."
    & git clone https://github.com/emscripten-core/emsdk.git $emsdkRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Could not clone the Emscripten SDK."
    }
}

Push-Location $emsdkRoot
try {
    Write-Host "Installing and activating the latest Emscripten SDK..."
    & .\emsdk.bat install latest
    if ($LASTEXITCODE -ne 0) {
        throw "Emscripten SDK installation failed."
    }

    & .\emsdk.bat activate latest
    if ($LASTEXITCODE -ne 0) {
        throw "Emscripten SDK activation failed."
    }
} finally {
    Pop-Location
}

Import-BatchEnvironment (Join-Path $emsdkRoot "emsdk_env.bat")

$requiredCommands = @(
    "node", "npm", "npx", "cmake", "ninja", "python", "emcc", "emcmake"
)
$missingCommands = $requiredCommands | Where-Object {
    -not (Get-Command $_ -ErrorAction SilentlyContinue)
}
if ($missingCommands) {
    throw "Required commands are still unavailable: $($missingCommands -join ', ')."
}

Write-Host "Installing temporary Node test dependencies..."
& npm install --no-save esbuild playwright
if ($LASTEXITCODE -ne 0) {
    throw "Node test dependencies could not be installed."
}

Write-Host "Configuring and building WebAssembly..."
& emcmake cmake -S . -B build-wasm -G Ninja `
    -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
if ($LASTEXITCODE -ne 0) {
    throw "Emscripten CMake configuration failed."
}

& cmake --build build-wasm
if ($LASTEXITCODE -ne 0) {
    throw "WebAssembly build failed."
}

Copy-Item web\* build-wasm\web -Recurse -Force

Write-Host "Running WebAssembly and parser tests..."
& node tests\wasm\loan_worker.test.cjs
if ($LASTEXITCODE -ne 0) {
    throw "Worker WebAssembly tests failed."
}

& node tests\cloudflare\input_parser.test.cjs
if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare input parser tests failed."
}

New-Item -ItemType Directory -Force build-wasm\worker | Out-Null
Write-Host "Bundling Worker for the local concurrency simulation..."
& npx esbuild cloudflare\worker\index.js --bundle --platform=node `
    --format=esm --target=node20 --loader:.wasm=binary `
    --outfile=build-wasm\worker\worker.mjs
if ($LASTEXITCODE -ne 0) {
    throw "Worker test bundle failed."
}

& node tests\cloudflare\worker_concurrency.test.cjs `
    build-wasm\worker\worker.mjs
if ($LASTEXITCODE -ne 0) {
    throw "Worker concurrency simulation failed."
}

Write-Host "Installing Chromium for browser tests..."
& npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    throw "Playwright browser installation failed."
}

& node tests\browser\loan-calculator.browser.test.cjs
if ($LASTEXITCODE -ne 0) {
    throw "Browser tests failed."
}

Write-Host "All pre-push tests passed."
