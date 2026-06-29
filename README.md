# Vault Tool — extensión local de VS Code / Windsurf

Extensión mínima de prueba para validar que puedes desarrollar, compilar y
**instalar localmente** (sin marketplace) una extensión que lea tu vault.

Incluye dos comandos:
- `Vault Tool: Listar notas del vault` — recorre la carpeta abierta buscando `.md`
- `Vault Tool: Abrir Kanban del vault` — abre un webview placeholder (aquí
  enchufarás tu lógica real de Kanban/Eisenhower más adelante)

## 1. Instalar dependencias

Dentro de la carpeta `vault-tool/`:

```bash
npm install -g @vscode/vsce
npm install
```

## 2. Probar en caliente (sin instalar nada todavía)

1. Abre la carpeta `vault-tool/` en VS Code o Windsurf.
2. Pulsa **F5** (o "Run > Start Debugging").
3. Se abrirá una segunda ventana ("Extension Development Host").
4. En esa segunda ventana, abre tu vault real (Archivo > Abrir carpeta...).
5. Abre la paleta de comandos (`Cmd+Shift+P`) y ejecuta:
   - `Vault Tool: Listar notas del vault`
   - `Vault Tool: Abrir Kanban del vault`

Si ves la lista de notas en el panel "Output" y el webview se abre, todo
funciona correctamente a nivel de código.

## 3. Compilar

```bash
npm run compile
```

Esto genera la carpeta `out/` con el JS compilado (necesario antes de empaquetar).

## 4. Empaquetar como .vsix

```bash
vsce package
```

Esto genera `vault-tool-0.0.1.vsix` en la carpeta. Si `vsce` se queja de
campos faltantes (repository, license, icon), puedes ignorar los avisos
para uso puramente local, o añadirlos si quieres limpiar el output.

## 5. Instalar el .vsix localmente

Opción A — desde terminal:
```bash
code --install-extension vault-tool-0.0.1.vsix
```
(o el comando equivalente de Windsurf, normalmente el mismo binario `code`
si Windsurf está basado en VS Code OSS — comprueba con `which code`)

Opción B — desde la interfaz:
1. Panel de Extensiones (icono lateral)
2. Menú "..." (arriba a la derecha del panel)
3. "Install from VSIX..."
4. Selecciona el fichero `.vsix` generado

A partir de aquí la extensión queda instalada permanentemente, igual que
cualquier otra del marketplace, pero **nunca ha salido de tu máquina ni ha
pasado por servidores externos** — esto es lo que conviene tener claro si
hay que justificarlo ante el equipo de seguridad de tu empresa.

## Siguientes pasos sugeridos

- Sustituir el listado simple de notas por lectura real de frontmatter
  (puedes usar `gray-matter` vía npm, ya que no requiere red en tiempo de
  ejecución, solo en tiempo de instalación de dependencias).
- Portar la lógica de tu sistema Kanban/Eisenhower (HTML/JS/CSS que ya
  tienes) dentro de `getHtmlContent()` del webview, sustituyendo el
  placeholder actual.
- Añadir un motor de queries tipo Dataview que recorra el vault y genere
  tablas/listas a partir del frontmatter.
