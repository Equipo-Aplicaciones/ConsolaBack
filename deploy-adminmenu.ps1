<#
Playbook Autodeploy - AdminMenu
Requisitos:
- Windows Server 2022
- Ejecutar como Administrador
#>

Write-Host "=== INICIANDO DEPLOY AUTOMÁTICO ===" -ForegroundColor Cyan

### EDITA ESTO ###
$backendRepoUrl = "https://github.com/Equipo-Aplicaciones/ConsolaBack.git"
$frontendRepoUrl = "https://github.com/Equipo-Aplicaciones/Consola_Front.git"
$deployBranch = "main"   # rama a desplegar en ambos repos
$appDir = "C:\apps\adminMenu"
$nodeVersion = "lts"  # opc: 18, 20, lts
$serviceName = "pm2-adminmenu"

#============================
# 1) Instalar Chocolatey
#============================

if (!(Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando Chocolatey..." -ForegroundColor Yellow
    Set-ExecutionPolicy Bypass -Scope Process -Force
    Invoke-WebRequest https://community.chocolatey.org/install.ps1 -UseBasicParsing | Invoke-Expression
} else {
    Write-Host "Chocolatey ya está instalado." -ForegroundColor Green
}

#============================
# 2) Instalar Node LTS & Git
#============================

Write-Host "Instalando NodeJS LTS y Git..." -ForegroundColor Yellow
choco install -y nodejs-$nodeVersion git

#============================
# 3) Crear carpeta del proyecto
#============================

Write-Host "Creando carpeta del proyecto..." -ForegroundColor Yellow
New-Item -Path "C:\apps" -ItemType Directory -Force | Out-Null
Remove-Item -Recurse -Force $appDir -ErrorAction SilentlyContinue
git clone --branch $deployBranch --single-branch $backendRepoUrl $appDir

cd $appDir

Write-Host "Clonando frontend..." -ForegroundColor Yellow
git clone --branch $deployBranch --single-branch $frontendRepoUrl client

#============================
# 4) Instalar dependencias server y client
#============================

Write-Host "Instalando dependencias del backend..." -ForegroundColor Yellow
npm install

Write-Host "Instalando dependencias del frontend..." -ForegroundColor Yellow
cd client
npm install
npm run build
cd ..

#============================
# 5) Instalar PM2 + Servicio Windows
#============================

Write-Host "Instalando PM2..." -ForegroundColor Yellow
npm install pm2 -g
npm install pm2-windows-service -g

Write-Host "Instalando servicio pm2..." -ForegroundColor Yellow
pm2-service-install -n $serviceName

#============================
# 6) Configurar PM2 app
#============================

Write-Host "Iniciando backend con PM2..." -ForegroundColor Yellow
pm2 delete adminmenu -s 2>$null
pm2 start src/server.js --name adminmenu --watch
pm2 save

#============================
# 7) Instalar IIS + ARR + URLRewrite
#============================

Write-Host "Instalando IIS + ARR + URL Rewrite..." -ForegroundColor Yellow
Install-WindowsFeature -name Web-Server -IncludeManagementTools

# URL Rewrite
Invoke-WebRequest "https://download.microsoft.com/download/D/0/9/D09C9C41-D511-4515-9ED0-9C42E4F180F7/rewrite_amd64_en-US.msi" -OutFile "rewrite.msi"
Start-Process msiexec.exe -ArgumentList "/i rewrite.msi /quiet" -Wait

# ARR
Invoke-WebRequest "https://download.microsoft.com/download/2/4/6/2466F0F1-0CE2-4AD3-9A11-E3D202138FDC/requestRouter_x64.msi" -OutFile "arr.msi"
Start-Process msiexec.exe -ArgumentList "/i arr.msi /quiet" -Wait

#============================
# 8) Crear sitio IIS (static React)
#============================

Write-Host "Creando sitio IIS para frontend..." -ForegroundColor Yellow

Import-Module WebAdministration

# Borrar sitio Default
Remove-WebSite -Name "Default Web Site" -ErrorAction SilentlyContinue

# Crear nuevo
New-WebSite -Name "AdminMenu" -Port 80 -PhysicalPath "$appDir\client\build" -Force

#============================
# 9) Mensajes finales
#============================

Write-Host "===================================================="
Write-Host "✅ Deploy completado"
Write-Host "Ruta app: $appDir"
Write-Host "Site IIS: http://localhost"
Write-Host "PM2 Service: $serviceName"
Write-Host "Ejecuta para ver logs: pm2 logs adminmenu"
Write-Host "Aún falta crear archivo .env en $appDir"
Write-Host "===================================================="
