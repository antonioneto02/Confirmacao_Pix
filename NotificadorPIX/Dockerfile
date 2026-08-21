FROM mcr.microsoft.com/windows/servercore:ltsc2022

ENV NODE_VERSION=22.23.2
SHELL ["powershell", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN Invoke-WebRequest -Uri "https://nodejs.org/dist/v$env:NODE_VERSION/node-v$env:NODE_VERSION-win-x64.zip" -OutFile C:\node.zip ; \
    Expand-Archive C:\node.zip -DestinationPath C:\ ; \
    Rename-Item "C:\node-v$env:NODE_VERSION-win-x64" C:\nodejs ; \
    Remove-Item C:\node.zip ; \
    setx /M PATH ('C:\nodejs;' + $env:PATH)

WORKDIR C:\\app
COPY package*.json ./
RUN & 'C:\nodejs\npm.cmd' ci --omit=dev
RUN Remove-Item -Recurse -Force 'C:\nodejs\node_modules\npm', 'C:\nodejs\node_modules\corepack' -ErrorAction SilentlyContinue ; \
    Remove-Item -Force 'C:\nodejs\npm', 'C:\nodejs\npm.cmd', 'C:\nodejs\npm.ps1', 'C:\nodejs\npx', 'C:\nodejs\npx.cmd', 'C:\nodejs\npx.ps1', 'C:\nodejs\corepack', 'C:\nodejs\corepack.cmd' -ErrorAction SilentlyContinue
COPY . .
EXPOSE 3013
CMD ["C:\\nodejs\\node.exe", "app.js"]
