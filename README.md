# Vault Tool — extensión local de VS Code / Windsurf

Extensión de VS Code / Windsurf que actúa como vault local tipo Obsidian.
Se instala localmente desde un `.vsix`, sin marketplace ni servidores externos.

## Resolución de imágenes (`![[archivo.png]]`)

1. Se busca primero en la carpeta de adjuntos configurada (`vaultTool.attachmentsLocation` /
   `vaultTool.attachmentsFolder`).
2. Si no está ahí, se busca recursivamente en toda la bóveda (primer archivo con ese
   nombre encontrado, asumiendo nombres únicos).
3. Si no se encuentra en ningún sitio, se muestra el texto del enlace tal cual, sin
   convertirlo en imagen.

La búsqueda recursiva usa `fs.statSync` como respaldo cuando el tipo de entrada de
directorio es ambiguo, porque las carpetas "solo en la nube" de Dropbox Smart Sync u
OneDrive Files On-Demand usan reparse points de NTFS que Node puede no reportar
correctamente como directorio en Windows.

## Resolución y creación de wikilinks (`[[Nota]]`)

- Sin ruta de desambiguación (`[[Nota]]`): se prioriza una nota con ese nombre en el
  mismo directorio que la nota que contiene el enlace; si no existe, se busca en toda
  la bóveda.
- Con ruta de desambiguación (`[[carpeta/Nota]]`): se busca `Nota.md` cuyo directorio
  padre inmediato se llame `carpeta` (no hace falta que sea la ruta completa).
- Si no se encuentra en ningún caso, se crea la nota en blanco: dentro del directorio
  `carpeta` (creándolo si no existe) dentro del directorio actual, o directamente en
  el directorio actual si no había ruta de desambiguación.

## Tareas (`- [ ] ...`) — integración con "Obsidian-Like Tasks"

Las líneas de checkbox se reconocen y renderizan como en Obsidian: checkbox real (clicable),
tachado al completar, fecha vencida en rojo. Los bloques ` ```tasks ` (con la misma sintaxis
de consulta que el plugin Tasks de Obsidian — `not done`, `group by`, filtros con expresiones
JS, etc.) se renderizan como una lista de tareas real dentro del propio editor.

Esto funciona como **dependencia opcional** de la extensión hermana `angelCastro.obsidian-like-tasks`
(repo `vscode-tasks`): si no está instalada, los checkboxes siguen funcionando con un toggle
simple `[ ]`↔`[x]` sin recurrencia, y los bloques `tasks` no se renderizan. Si está instalada,
toda la lógica de parseo/recurrencia/queries vive ahí — Vault Tool solo pinta el resultado y
reenvía los clics. Detalle técnico completo en `CLAUDE.md`.

## Siguientes pasos sugeridos

- Sustituir el listado simple de notas por lectura real de frontmatter
  (puedes usar `gray-matter` vía npm, ya que no requiere red en tiempo de
  ejecución, solo en tiempo de instalación de dependencias).
- Portar la lógica de tu sistema Kanban/Eisenhower (HTML/JS/CSS que ya
  tienes) dentro de `getHtmlContent()` del webview, sustituyendo el
  placeholder actual.
- Motor de queries tipo Dataview sobre frontmatter: ya existe un motor de queries real para
  **tareas** (vía la integración de arriba), pero no para notas/frontmatter en general —
  seguiría siendo una pieza nueva y separada.

## Tareas pendientes

- [ ] Escribir un wikilink `[[` con sugerencias — al escribir `[[` en el
  editor, mostrar un desplegable con los nombres de las notas del vault para
  autocompletar el enlace.
- [ ] Color diferente y navegación según estado del wikilink — los enlaces
  válidos se muestran en un color y al pulsarlos abren la nota destino; los
  enlaces rotos se muestran en otro color (p. ej. rojo o gris).
- [ ] Frontmatter — parsear el bloque YAML entre `---` al inicio de cada nota
  y exponerlo para queries y vistas.
- [ ] Calendario — vista de calendario que muestra notas por fecha (usando
  campo de frontmatter, p. ej. `date:`).
- [ ] Bases de datos — vista tabular tipo Dataview que agrupa y filtra notas
  por campos de frontmatter.
- [ ] Templates — sistema de plantillas para crear notas nuevas a partir de
  un fichero base predefinido.
- [ ] Mover ficheros `.md` actualiza los enlaces — al renombrar o mover una
  nota, buscar y actualizar automáticamente todos los `[[wikilinks]]` que
  apuntaban a su ruta anterior en el resto del vault.
- [ ] Transclusiones — soporte de `![[nota]]` para incrustar el contenido de
  otra nota (o un bloque concreto) dentro de la nota actual.
- [ ] HTML para los highlights
- [ ] Bloques, como los de las notas o los códigos fuentes
- [ ] `términos` y ```bloques```
- [ ] Abrir archivos con el selector de ficheros (CTRL+O)
