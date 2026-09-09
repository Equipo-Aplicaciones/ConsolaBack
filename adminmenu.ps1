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


#============================
# 3) Crear carpeta del proyecto
#============================

git clone --branch $deployBranch --single-branch $backendRepoUrl $appDir

cd $appDir

Write-Host "Clonando frontend..." -ForegroundColor Yellow
git clone --branch $deployBranch --single-branch $frontendRepoUrl client

#============================
# 4) Instalar dependencias server y client
#============================

Write-Host "Instalando dependencias del backend..." -ForegroundColor Yellow
npm install

