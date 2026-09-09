# Flujo de trabajo

Este repo (`ConsolaBack`) y su frontend (`Consola_Front`) usan el mismo flujo.

## Reglas

- `main` está protegida: no se puede hacer push directo, ni siquiera como admin.
- Todo cambio entra por una rama y un Pull Request hacia `main`.
- Un PR necesita:
  - Al menos 1 aprobación de otro colaborador.
  - El check de CI en verde (`install-and-check` en este repo, `build-and-test` en Consola_Front).
  - Estar actualizado contra `main` antes de mergear.

## Pasos para un cambio

1. `git checkout main && git pull`
2. `git checkout -b feature/nombre-descriptivo`
3. Commitear y `git push origin feature/nombre-descriptivo`
4. Abrir el Pull Request en GitHub hacia `main`.
5. Esperar CI en verde + aprobación de un compañero.
6. Mergear desde GitHub (no localmente).

## Deploy a producción

El deploy sigue siendo manual (`deploy-adminmenu.ps1` / `adminmenu.ps1` en el servidor), pero ahora clona `main` de `ConsolaBack` y `Consola_Front` por separado — código que ya pasó por CI y revisión, no lo último que alguien tenía en su máquina.
