# Obsidian-like — extensión local de VS Code / Windsurf

Extensión de VS Code / Windsurf que actúa como vault local tipo Obsidian.
Se instala localmente desde un `.vsix`, sin marketplace ni servidores externos.

## Resolución de imágenes (`![[archivo.png]]`)

1. Se busca primero en la carpeta de adjuntos configurada (`obsidianLike.attachmentsLocation` /
   `obsidianLike.attachmentsFolder`).
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
- Con sección (`[[Nota#Encabezado]]`): al hacer clic, abre la nota y hace scroll hasta
  ese encabezado (de cualquier nivel, no solo `#`).
- Si no se encuentra en ningún caso, se crea la nota en blanco: dentro del directorio
  `carpeta` (creándolo si no existe) dentro del directorio actual, o directamente en
  el directorio actual si no había ruta de desambiguación.
- Autocompletado al escribir `[[`: busca notas por nombre; al añadir `#`, cambia a
  buscar encabezados de esa nota concreta, en el mismo orden en que aparecen en el
  documento.
- Al mover o renombrar una nota (desde el explorador de VS Code o el título dentro del
  editor), todos los `[[wikilinks]]` que apuntaban a ella en el resto de la bóveda se
  actualizan automáticamente — añadiendo o quitando la carpeta de desambiguación según
  corresponda a la nueva ubicación.
- Modo fuente vs. vista previa: cada `[[wikilink]]` cambia a texto plano (corchetes
  visibles, sin subrayado ni color de enlace, no clicable) solo mientras el cursor está
  entre sus propios corchetes — si hay varios `[[enlaces]]` en la misma línea, el resto
  se sigue mostrando renderizado normalmente aunque el cursor esté en esa línea.

## Transclusiones (`![[nota]]`, `![[carpeta/nota]]`, `![[nota#sección]]`)

Incrusta el contenido de otra nota (completa o solo una sección) dentro de un
rectángulo con un botón "↗" para abrir la nota de origen (y hacer scroll a la
sección, si la hay). Se resuelve de forma asíncrona contra el host, igual que
los bloques ` ```tasks ` de la integración de Tareas.

## Vista previa al pasar el ratón (`Ctrl`/`Cmd` + hover sobre un `[[wikilink]]`)

Manteniendo pulsado `Ctrl` (o `Cmd` en macOS) mientras el cursor del ratón está
sobre un `[[wikilink]]` (también funciona sobre los enlaces dentro de una
tabla), aparece un pequeño popup flotante con el contenido de la nota
apuntada (o solo la sección, si el enlace incluye `#Encabezado`) — igual que
la vista previa de página de Obsidian. Se puede mover el ratón hacia el
propio popup para leerlo con calma sin que se cierre; se cierra al soltar
`Ctrl`/`Cmd` o al mover el ratón fuera del enlace y del popup.

## Abrir nota (`Ctrl+O` / `Cmd+O`)

Selector flotante (`QuickPick` nativo de VS Code — un webview no puede flotar
como diálogo modal, siempre ocupa una pestaña fija) con:

- Buscador arriba; al dejarlo vacío muestra el histórico de notas abiertas
  recientemente (persistente entre sesiones), y al escribir busca por nombre
  en toda la bóveda.
- Si el texto escrito no coincide con ninguna nota, aparece la opción de
  crearla (soporta subcarpetas escribiendo `carpeta/Nombre`).
- `Enter` abre sustituyendo la nota actual, `Ctrl+Enter` abre en una pestaña
  nueva, `Ctrl+Alt+Enter` abre en una columna a la derecha.

La posición del diálogo (anclado arriba, centrado horizontalmente) no es
configurable — es una limitación de la API de VS Code, no algo pendiente de
ajustar.

## Adjuntar archivos arrastrando o desde el explorador

Arrastrar un archivo desde el sistema operativo sobre el editor debería
copiarlo a la carpeta de adjuntos e insertar `![[archivo]]` en el punto donde
se suelta — igual que en Obsidian — pero VS Code puede interceptar el drop
antes de que llegue al webview (ver detalle en `CLAUDE.md`, sección "Drag &
drop"; no confirmado como 100% fiable). El camino garantizado: clic derecho
sobre uno o varios archivos en el explorador de VS Code → "Obsidian-like:
Insertar como adjunto en la nota activa".

## Código inline y bloques de código

Los backtick `` ` `` de código inline se ocultan salvo en la línea activa o en
modo fuente, igual que otros marcadores markdown. Los bloques ` ```código``` `
se renderizan como una caja unificada (no una fila de "píldoras" por línea) y
las líneas ` ``` ` de apertura/cierre desaparecen del todo mientras no estás
editando dentro del bloque. La fuente monoespaciada usada en ambos casos es
configurable por separado de la fuente general (`obsidianLike.codeFont`), y su
tamaño también (`obsidianLike.codeFontSize`, 14px por defecto).

## Cabeceras (`#`, `##`, `###`...)

La barra de color vertical junto a cada cabecera reproduce el estilo del tema
de Obsidian configurado (color, ancho, alto igual al del texto). El pequeño
indicador de nivel ("H1", "H2"...) permanece oculto y solo aparece al pasar el
ratón sobre la cabecera (la barra o el propio texto), igual que en Obsidian —
también sirve para plegar/desplegar la sección. Detalle técnico completo en
`CLAUDE.md`.

## Tareas (`- [ ] ...`) — integración con "Obsidian-like Tasks"

Las líneas de checkbox se reconocen y renderizan como en Obsidian: checkbox real (clicable),
tachado al completar, fecha vencida en rojo, con el mismo tamaño/alineación para los iconos de
estado no estándar (en curso, en espera, delegada, cancelada) que para el checkbox nativo. Con el
cursor sobre la línea de la tarea, el atajo `Shift+Alt+E` (comando `vaultTool.editTaskAtCursor`)
abre el diálogo "Create or edit Task" de la extensión de Tasks, ya relleno con los datos de esa
tarea concreta.

Los bloques ` ```tasks ` (con la misma sintaxis de consulta que el plugin Tasks de Obsidian —
`not done`, `group by`, filtros con expresiones JS, etc.) se renderizan como una lista de tareas
real dentro del propio editor: cada fila muestra checkbox, tags como pills, ID, prioridad,
dependencias, fechas y un backlink clicable a la nota (con el encabezado bajo el que está la
tarea, si tiene uno) — con un botón ✏️ propio para editar esa tarea concreta sin salir del
listado. Encima del listado hay un filtro de texto por descripción, y debajo un contador de
tareas mostradas, igual que en Obsidian.

Esto funciona como **dependencia opcional** de la extensión hermana `angelCastro.obsidian-like-tasks`
(repo `obsidianlike_tasks`): si no está instalada, los checkboxes siguen funcionando con un toggle
simple `[ ]`↔`[x]` sin recurrencia, los bloques `tasks` no se renderizan, y `Shift+Alt+E`/el botón
✏️ de una fila avisan de que hace falta esa extensión en vez de abrir nada. Si está instalada, toda
la lógica de parseo/recurrencia/queries/edición vive ahí — Obsidian-like solo pinta el resultado y
reenvía los clics (`toggle-task`/`toggle-task-at-location` para el checkbox,
`edit-task-at-location` para el botón de editar de una fila). Detalle técnico completo en
`CLAUDE.md`.

## Compatibilidad multiplataforma (Windows / macOS)

La búsqueda del tema de Obsidian configurado (`obsidianLike.obsidianTheme`) es
insensible a mayúsculas/minúsculas y no depende de que el sistema de ficheros
reporte correctamente si una entrada es un directorio (falla en vaults
sincronizados por iCloud/Dropbox/OneDrive) — si aun así no se encuentra,
se avisa con la ruta exacta comprobada en vez de fallar en silencio.

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
- [ ] Confirmar de forma fiable el drag & drop de archivos externos sobre el
  editor (ahora mismo el camino garantizado es el comando de menú contextual
  del explorador, no arrastrar directamente).
