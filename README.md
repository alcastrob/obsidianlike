# Obsidian-like — extensión local de VS Code / Windsurf

Extensión de VS Code / Windsurf que actúa como vault local tipo Obsidian.
Se instala localmente desde un `.vsix`, sin marketplace ni servidores externos.

## Seguridad: sin llamadas de red externas

Auditado (2026-07-14) revisando `src/extension.ts`, `webview-src/editor.js`, los
artefactos compilados (`out/extension.js`, `out/editor.bundle.js`), `package.json`
y los temas empaquetados, buscando `fetch`/`XMLHttpRequest`/`http`/`https`/
`WebSocket`/`EventSource`/telemetría/analítica. **No se encontró ninguna llamada
de red automática ni ningún SDK de telemetría o diagnóstico.**

- El único punto que toca una URL es el handler del mensaje `open-url`
  (`src/extension.ts`) — que a su vez solo se envía al hacer **clic** en un
  enlace markdown estándar (texto entre corchetes seguido de la URL entre
  paréntesis), una URL suelta dentro de una nota, o (desde esta versión) un
  `[[wikilink]]` dentro de una celda de tabla. Es decir: abre el navegador del
  sistema únicamente cuando el usuario clica un enlace, igual que cualquier
  visor de Markdown. La apertura en sí ya no pasa por `vscode.env.openExternal`
  — se detectó que esa API podía alterar caracteres de una URL muy larga con
  parámetros ya codificados (`%3F`/`%3D`/`%26`/...) al llegar a la barra de
  direcciones del navegador, así que ahora se lanza directamente el mecanismo
  "abrir" del propio sistema operativo (`cmd.exe /c start`/`open`/`xdg-open`,
  vía `execFile` con argumentos en array, sin intérprete de shell de por
  medio) con la URL intacta. Sigue siendo un proceso local del sistema, no una
  llamada de red hecha por la extensión.
- El CSP del webview (`default-src 'none'; img-src ${cspSource} data: blob:;
  script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src
  'unsafe-inline';`) no incluye `connect-src`, así que hereda `default-src
  'none'` — cualquier `fetch`/`XMLHttpRequest`/`WebSocket` quedaría bloqueado
  por el propio navegador embebido aunque se colara código que lo intentara.
  `img-src` tampoco permite `https:`/`http:` genérico, solo el origen propio
  del webview, `data:` y `blob:` — ni una imagen remota referenciada por un
  tema de Obsidian cargado localmente podría cargarse.
- Dependencias en tiempo de ejecución (`package.json` → `dependencies`):
  únicamente paquetes de CodeMirror (`@codemirror/*`, `@lezer/highlight`) y
  `marked` — ninguno hace peticiones de red. `marked` y
  `@codemirror/autocomplete` están declarados pero no se importan en ningún
  archivo (dependencias muertas, sin riesgo pero pendientes de limpieza).
  `devDependencies` (typescript, esbuild, vsce) no se empaquetan en el `.vsix`.

Esta revisión cubre únicamente este repositorio. Las extensiones hermanas
(`obsidianlike_tasks`, `_calendar`, `_search`, `_dataview`, `_dbfolder`,
`_clearunusedimages`, ver `make.bat`) viven en repos separados y no están
auditadas aquí.

## Autoguardado

El editor guarda la nota en disco por su cuenta: tras `obsidianLike.autoSaveDelay`
milisegundos (3000 por defecto) sin más cambios, se guarda automáticamente. Al
cerrar la pestaña de la nota, o al cerrar VS Code con notas sin guardar todavía,
también se fuerza ese guardado en vez de esperar a que venza el temporizador —
sin el diálogo de "¿Guardar cambios?", los cambios simplemente se guardan
siempre. Para lograrlo, la extensión activa `files.autoSave` de VS Code
(`afterDelay`) pero **solo para archivos markdown** (override de lenguaje,
`[markdown]` en el `settings.json` del perfil "Obsidian like" — no afecta a
otros tipos de archivo), ya que es la única forma soportada de que VS Code deje
de preguntar antes de cerrar una pestaña con cambios.

Cambiar de pestaña (sin editar nada) ya no marca la nota que dejas atrás como "con cambios sin
guardar" ni dispara un guardado de fondo — antes, el mecanismo interno que sincroniza el contenido
del editor al cerrar/perder el foco de una pestaña reenviaba el contenido igual aunque no hubiera
cambiado, y VS Code marca "sucio" un documento en cuanto se le aplica cualquier edición, aunque el
texto resultante sea idéntico.

Si la misma nota está abierta a la vez en **dos ventanas** distintas de VS Code, el
autoguardado comprueba la fecha de modificación real del fichero antes de escribir: si detecta
que la otra ventana ya guardó algo más reciente que lo que esta ventana conoce, se salta ese
guardado automático en vez de sobrescribirlo en silencio, y avisa una sola vez con un mensaje
explicando que puedes forzar tu versión con `Ctrl+S` o cerrar la pestaña sin guardar para
conservar la del disco (cerrar sin guardar también respeta esa misma comprobación). No resuelve
una edición realmente simultánea en ambas ventanas — para eso hay que decidir a mano cuál de las
dos versiones se queda.

## Frontmatter YAML → panel "Propiedades"

El bloque `---...---` al principio de la nota se muestra como un panel
"Propiedades" interactivo, igual que en Obsidian, en vez de como texto YAML en
crudo: las propiedades de tipo lista (como `tags`) aparecen como chips con una
"×" para quitarlas y un campo para añadir más; las de texto/número como un
campo editable; las booleanas como checkbox. "+ Añadir propiedad" crea una
propiedad de texto nueva (para crear una propiedad de tipo lista desde cero, o
renombrar una clave, hace falta editar el YAML directamente en modo fuente —
comando "Obsidian-like: Alternar vista fuente / WYSIWYG"). Si el bloque
usa una sintaxis YAML que el analizador no reconoce con seguridad (comentarios,
mapas anidados, anclas...), se deja el texto en crudo tal cual en vez de
arriesgarse a corromperlo al guardar.

El panel se muestra pegado a la parte de arriba de la nota (sin el hueco que deja el resto de
notas por el margen superior del editor). El cursor no se puede colocar dentro del frontmatter de
ninguna forma — ni haciendo clic sobre él ni con las flechas subir/bajar desde la primera línea de
contenido real — ya que la edición pasa siempre por los controles del propio panel, nunca por el
texto YAML subyacente en vista previa.

## Resolución de imágenes (`![[archivo.png]]`)

1. Se busca primero en la carpeta de adjuntos configurada (`obsidianLike.attachmentsLocation` /
   `obsidianLike.attachmentsFolder`).
2. Si no está ahí, se busca recursivamente en toda la bóveda (primer archivo con ese
   nombre encontrado, asumiendo nombres únicos).
3. Si no se encuentra en ningún sitio, se muestra un aviso ("No se encontró «archivo.png».")
   en vez del texto del enlace en crudo o de una imagen rota.

La búsqueda recursiva usa `fs.statSync` como respaldo cuando el tipo de entrada de
directorio es ambiguo, porque las carpetas "solo en la nube" de Dropbox Smart Sync u
OneDrive Files On-Demand usan reparse points de NTFS que Node puede no reportar
correctamente como directorio en Windows.

### Formatos admitidos

Extensiones tratadas como imagen: `png`, `jpg`/`jpeg`, `gif`, `svg`, `webp`, `bmp`.
Un `![[diagrama.svg]]` se renderiza igual que un `.png`.

**`![[diagrama.drawio]]`** también se renderiza como imagen: un conversor propio
(en `src/drawio.ts`, del lado del host) transforma el mxGraphModel a SVG en línea
—soporta tanto el XML sin comprimir como el `<diagram>` comprimido (base64 +
deflate), y también archivos `.drawio` cuyo contenido ya es un SVG ("Editable
SVG" de draw.io)—. Cubre el subconjunto habitual de un diagrama hecho a mano:
rectángulos (con o sin esquinas redondeadas), elipses, rombos, triángulos,
paralelogramos, hexágonos y cilindros; aristas (recta o con puntos intermedios,
recortadas al borde de la forma) con puntas de flecha; y etiquetas con sus
colores de relleno/borde/fuente y su alineación. **No reproduce**: degradados,
formas personalizadas (`shape=mxgraph.*`), swimlanes, imágenes incrustadas,
grupos con geometría relativa ni el enrutado de aristas curvas — para diagramas
complejos, exporta desde draw.io como `.drawio.svg`/`.drawio.png` (que ya se
renderizan por su extensión) o abre el archivo en el editor de draw.io. Si el
archivo no se puede interpretar como diagrama, el embed muestra una caja para
abrirlo con draw.io en vez de una imagen rota.

`![[diagrama.drawio]]` como **embed** se ve como imagen; `[[diagrama.drawio]]`
como **enlace** normal sigue abriendo el archivo en el editor de draw.io del
sistema. El mapa de imágenes se calcula al abrir la nota, así que editar un
`.drawio` mientras su nota está abierta requiere recargar la nota para que se
vuelva a renderizar.

## Resolución y creación de wikilinks (`[[Nota]]`)

- La búsqueda es siempre **por toda la bóveda primero**, nunca limitada al directorio
  de la nota que contiene el enlace ni a uno indicado como pista — eso incluye un
  enlace dentro de una tarea listada por un bloque ` ```tasks `, cuyo destino puede
  estar en cualquier directorio, sin relación con la nota que muestra el listado ni con
  la nota donde vive esa tarea en concreto.
- Sin ruta de desambiguación (`[[Nota]]`): si solo hay una nota con ese nombre en toda
  la bóveda, es esa. Si hay varias, se prioriza la del mismo directorio que la nota que
  contiene el enlace; si ninguna coincide, se usa la primera encontrada.
- Con ruta de desambiguación (`[[carpeta/Nota]]`): si hay varias notas con ese nombre,
  se prioriza la que esté dentro de un directorio llamado `carpeta` (no hace falta que
  sea la ruta completa) — la ruta solo desempata entre varias, no limita la búsqueda a
  ese directorio.
- Con sección (`[[Nota#Encabezado]]`): al hacer clic, abre la nota y hace scroll hasta
  ese encabezado (de cualquier nivel, no solo `#`).
- Solo si no existe **ninguna** nota con ese nombre en toda la bóveda se crea una en
  blanco: dentro del directorio `carpeta` (creándolo si no existe) dentro del directorio
  actual, o directamente en el directorio actual si no había ruta de desambiguación.
- Autocompletado al escribir `[[`: busca notas por nombre; al añadir `#`, cambia a
  buscar encabezados de esa nota concreta, en el mismo orden en que aparecen en el
  documento.
- Al mover o renombrar una nota (desde el explorador de VS Code o el título dentro del
  editor), todos los `[[wikilinks]]` que apuntaban a ella en el resto de la bóveda se
  actualizan automáticamente — añadiendo o quitando la carpeta de desambiguación según
  corresponda a la nueva ubicación.
- Modo fuente vs. vista previa: un `[[wikilink]]` cambia a texto plano (corchetes
  visibles, sin subrayado ni color de enlace) en cuanto el cursor entra en sus
  corchetes de forma deliberada — al escribir o borrar una letra, con las flechas
  izquierda/derecha, `Inicio`/`Fin`, o con un clic. La única excepción es mover el
  cursor arriba/abajo: si ese movimiento simplemente *atraviesa* un enlace de paso
  (camino a otra línea), no lo activa — solo desactiva uno que ya estuviera activo al
  salir de él. Una vez activado, permanece en modo fuente (incluso si luego solo mueves
  el cursor dentro del mismo enlace) hasta que el cursor sale de sus corchetes externos,
  momento en el que vuelve a la vista normal. Si hay varios `[[enlaces]]` en la misma
  línea, el resto se sigue mostrando renderizado normalmente aunque uno esté activado.

## Enlaces a una cabecera del mismo documento (`[[#Encabezado]]`)

Un wikilink sin nombre de nota, solo `#Encabezado`, apunta a una cabecera dentro de la propia
nota (no a otro fichero): se muestra como un enlace resuelto normal (no como enlace roto) cuando
esa cabecera existe en el documento, y al hacer clic hace scroll hasta ella en vez de intentar
abrir o crear un fichero. Escribir `[[#` también ofrece autocompletado con las cabeceras de la
propia nota, igual que `[[Nota#` lo hace con las de otra nota.

## Enlaces a `.docx`, `.xlsx` y `.pdf`

Un wikilink a un fichero de estos tres tipos (`[[informe.docx]]`, `[[presupuesto.xlsx]]`,
`[[manual.pdf]]`) no intenta abrirse como una nota: al hacer clic, se busca el fichero por toda la
bóveda (mismas reglas de desambiguación con `carpeta/` que un wikilink normal) y se abre con la
aplicación que tenga configurada el sistema operativo — Word, Excel, el lector de PDF que sea, lo
que corresponda. Si el fichero no aparece en la bóveda, se muestra un aviso en vez de crear nada
(a diferencia de un `[[wikilink]]` normal, no tiene sentido crear un `.docx` en blanco).

Un `![[...]]` (embed) de uno de estos tres tipos se muestra como una caja pequeña con el nombre del
fichero, clicable de la misma forma — no como texto incrustado, ya que no hay nada de markdown que
renderizar. Si el fichero no existe en la bóveda, esa caja se sustituye por el mismo aviso de
"No se encontró" que una imagen rota.

## Buscar y reemplazar (`Ctrl+F` / `Cmd+F`)

Panel flotante arriba a la derecha, igual que en Obsidian: campo de búsqueda con contador de
coincidencias ("3 de 12"), toggles de sensible a mayúsculas / palabra completa / expresión
regular, botones anterior/siguiente/seleccionar todas las coincidencias, y una fila de
"Reemplazar" colapsable (con su propio toggle "AB" para preservar mayúsculas/minúsculas al
reemplazar en texto plano — no aplica con regex) con botones de reemplazar uno o todos. Queda
fijo en pantalla al hacer scroll por la nota. El menú nativo **Editar → Buscar** no abre este
panel — es una limitación de VS Code, no algo pendiente de arreglar (ese ítem de menú invoca
siempre el comando de búsqueda genérico de VS Code, pensado para un editor de texto normal, y no
hay forma de redirigirlo desde una extensión); usa `Ctrl+F` o la paleta de comandos
("Obsidian-like: Buscar y reemplazar").

## Línea horizontal (`---`)

Un `---` (o `***`/`___`) solo en su propia línea se dibuja como una línea horizontal real, igual
que en Obsidian, en vez de mostrar los guiones tal cual. Los delimitadores `---` del frontmatter
no se ven afectados — ya tienen su propio tratamiento como panel de "Propiedades" (ver arriba).

## Transclusiones (`![[nota]]`, `![[carpeta/nota]]`, `![[nota#sección]]`)

Incrusta el contenido de otra nota (completa o solo una sección) dentro de un
rectángulo con un botón "↗" para abrir la nota de origen (y hacer scroll a la
sección, si la hay). Se resuelve de forma asíncrona contra el host, igual que
los bloques ` ```tasks ` de la integración de Tareas. Al incrustar una sección
(`![[nota#Cabecera]]`), se incluye todo el contenido hasta la siguiente cabecera
del **mismo rango o superior** (o el final del fichero) — las cabeceras de rango
inferior anidadas dentro (por ejemplo, los `##`/`###` bajo un `#`) se incluyen
con todo su contenido, no cortan la transclusión. Dentro de esa sección incrustada,
una imagen (`![[foto.png]]`) se muestra como imagen real, un enlace a un `.docx`/`.xlsx`/`.pdf`
se muestra como una caja clicable para abrirlo con la aplicación del sistema, y las líneas de
tarea (`- [ ] ...`) muestran su checkbox (de solo lectura, ya que editar una tarea transcluida no
tiene sentido — para eso está la nota de origen) y el tachado de "hecho", en vez de mostrarse
como texto markdown sin procesar. Cada línea del documento origen conserva su propio salto de
línea al transcluirse — por ejemplo, varios `[[wikilinks]]` escritos uno por línea (sin línea en
blanco entre ellos) aparecen cada uno en su propia línea, no todos seguidos formando un párrafo.
Una transclusión dentro de otra transclusión no se resuelve de forma recursiva.

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

## Duplicar archivo

Clic derecho sobre uno o varios archivos en el explorador de VS Code →
"Obsidian-like: Duplicar archivo" crea una copia junto al original, añadiendo
`_copia` al nombre (p. ej. `Nota.md` → `Nota_copia.md`). Si ya existe una copia
con ese nombre, añade un número (`Nota_copia 2.md`, etc.) en vez de sobrescribirla.

## Navegación vertical del cursor (flechas arriba/abajo)

Subir/bajar con el cursor se mueve por **fila visual en pantalla**, no por línea
de fichero — un párrafo largo que ocupa varias líneas en pantalla (con el ajuste
de línea activado) navega fila a fila dentro de él, en vez de saltar directamente
a la siguiente línea real del documento. Necesitó una implementación propia
porque los marcadores markdown que este editor oculta/muestra según en qué línea
está el cursor (viñetas, wikilinks...) confunden el algoritmo por píxeles nativo
de CodeMirror cuando cambia de línea activa entre pulsaciones — ver `CLAUDE.md`
para el detalle técnico completo.

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
también sirve para plegar/desplegar la sección; el plegado (y el atajo de
teclado arriba/abajo que salta por encima de una sección plegada) solo
funciona en vista previa, no en modo fuente, donde no tiene sentido ocultar
nada. El espacio superior entre cabeceras se aplica como `padding` (no
`margin`) de la línea: un `margin` en una línea es invisible para el modelo de
alturas de CodeMirror y desalineaba los clics respecto al puntero. El
indicador "H1"/"H2" y la barra de color se centran sobre el *texto* de la
cabecera, no sobre ese hueco superior. Un `[texto entre corchetes]` dentro de
una cabecera se ve exactamente igual que el resto de la línea (mismo tamaño,
grosor, tipografía y color) en vez de destacar con un estilo distinto — lo
mismo aplica a los corchetes internos de un `[[wikilink]]` en modo fuente
dentro de un párrafo normal: tanto los corchetes dobles exteriores como los
interiores se ven al mismo tamaño que el texto. Detalle técnico completo en
`CLAUDE.md`.

### Cursor en una sección colapsada

Con una cabecera plegada ("Título …"), el cursor puede colocarse **a la
derecha de la elipsis** (misma altura que sobre el texto de la cabecera, y la
cabecera sigue viéndose "Título …", no `# Título …` en crudo). Desde ahí:

- Escribir añade el texto al final del contenido oculto de la sección y la
  despliega.
- Pulsar `→` salta directamente al **primer carácter de la siguiente
  cabecera** (sin pasar por posiciones intermedias raras en el margen).
- Si es la **última** sección del documento, `→` no hace nada: el cursor se
  queda a la derecha de la elipsis.

## Texto resaltado (`==texto==`)

El texto encerrado entre dos signos `=` se muestra resaltado (fondo amarillo por
defecto, o el color que defina el tema de Obsidian vía `--text-highlight-bg`),
igual que en Obsidian. Los signos `==` se ocultan salvo en la línea activa o en
modo fuente, igual que los marcadores de negrita/cursiva/tachado.

## Resaltado con color (estilo Highlightr)

Con una selección de texto, el menú contextual (clic derecho) ofrece un submenú
"Highlights" con la paleta de colores configurada
(`obsidianLike.highlighterColors`) más "Quitar resaltado". Elegir un color envuelve
la selección en `<mark style="background-color:...">` (o `<mark class="hltr-...">`
si `obsidianLike.highlighterUseCssClasses` está activado); volver a pulsar el mismo
color lo quita, y pulsar uno distinto lo cambia. Solo aparece al pulsar con el botón
derecho — no hay ningún menú/toolbar que se abra solo al seleccionar texto con el ratón.

## Listas numeradas — renumerado automático, sangría con `Tab`

Al borrar (o añadir) un elemento en medio de una lista numerada, el resto de la
lista se renumera automáticamente para seguir siendo consecutiva — por ejemplo,
borrar el punto "2." de una lista 1/2/3 convierte el antiguo "3." en "2." sin
tener que tocarlo a mano. Respeta el número con el que empezó la lista (si
empieza en "5.", sigue empezando ahí) y no afecta a sublistas anidadas con su
propio nivel de numeración — cada nivel de anidamiento se renumera de forma
independiente.

Con el cursor en una línea de lista (numerada o de viñetas), `Tab` la anida
como sublista bajo el elemento hermano justo encima (numerada: reinicia en
"1.", uniéndose a la numeración de esa sublista si ya existe una ahí debajo;
de viñetas: conserva su propio marcador). `Mayús+Tab` hace lo contrario, la
saca de la sublista. En ambos casos, la lista de la que sale y la sublista en
la que entra se renumeran automáticamente para no dejar huecos.

El color e indentación de los marcadores de lista respetan las variables del
tema de Obsidian cargado (`--list-marker-color`, `--list-indent`) cuando están
definidas, en vez de un valor fijo.

## Tareas (`- [ ] ...`) — integración con "Obsidian-like Tasks"

Las líneas de checkbox se reconocen y renderizan como en Obsidian: checkbox real (clicable),
tachado al completar, fecha vencida en rojo, con el mismo tamaño/alineación para los iconos de
estado no estándar (en curso, en espera, delegada, cancelada) que para el checkbox nativo. Una
tarea suelta en el nivel superior del documento se alinea con el mismo margen izquierdo que el
texto normal — no aparece indentada como una sublista, salvo que esté anidada bajo otra tarea o
bajo una lista, en cuyo caso conserva su nivel de anidamiento relativo. Con el cursor sobre la
línea de la tarea, el atajo `Shift+Alt+E` (comando `vaultTool.editTaskAtCursor`) abre el diálogo
"Create or edit Task" de la extensión de Tasks, ya relleno con los datos de esa tarea concreta.
Una dirección `https://`/`http://` suelta dentro del texto de la tarea (sin un enlace markdown
explícito alrededor) se convierte en un enlace clicable igual que uno explícito.

Los bloques ` ```tasks ` (con la misma sintaxis de consulta que el plugin Tasks de Obsidian —
`not done`, `group by`, filtros con expresiones JS, etc.) se renderizan como una lista de tareas
real dentro del propio editor, en la misma columna de ancho de lectura (y con el mismo margen
izquierdo/derecho) que el resto de la nota: cada fila muestra checkbox, tags como pills, ID,
prioridad, dependencias, fechas y un backlink clicable a la nota (con el encabezado bajo el que
está la tarea, si tiene uno) — al hacer clic, abre esa nota en una pestaña nueva (sin cerrar el
listado) y hace scroll hasta la línea exacta de la tarea, dejando el cursor al principio de esa
línea. Con un botón ✏️ propio para editar esa tarea concreta sin salir del
listado. Pasar el cursor sobre el id de una dependencia (`⛔`), o sobre el `ID` propio de una tarea
de la que dependen otras, muestra un popup con la descripción y ubicación de la tarea referenciada.
Encima del listado hay un filtro de texto por descripción, y debajo un contador de
tareas mostradas, igual que en Obsidian. Igual que en una tarea suelta, una URL suelta dentro de
la descripción también se muestra como enlace clicable. Añadiendo una línea `zoom factor 80%` a la
consulta (propio de este port, no del plugin Tasks original) se reduce el tamaño de todo el
listado — texto, emojis, badges — al porcentaje indicado, útil para listados largos; sin esa
línea, tamaño normal.

Esto funciona como **dependencia opcional** de la extensión hermana `angelCastro.obsidian-like-tasks`
(repo `obsidianlike_tasks`): si no está instalada, los checkboxes siguen funcionando con un toggle
simple `[ ]`↔`[x]` sin recurrencia, los bloques `tasks` no se renderizan, y `Shift+Alt+E`/el botón
✏️ de una fila avisan de que hace falta esa extensión en vez de abrir nada. Si está instalada, toda
la lógica de parseo/recurrencia/queries/edición vive ahí — Obsidian-like solo pinta el resultado y
reenvía los clics (`toggle-task`/`toggle-task-at-location` para el checkbox,
`edit-task-at-location` para el botón de editar de una fila). Detalle técnico completo en
`CLAUDE.md`.

## Tablas Markdown

Una tabla ` | así | ` se renderiza como una tabla real, y se edita directamente sobre ella: haz
clic en cualquier celda y escribe — no hace falta ver ni tocar los `|` de la sintaxis en ningún
momento. `Tab`/`Mayús+Tab` mueven el cursor a la celda siguiente/anterior; `Intro` baja a la misma
columna en la fila de abajo. Tabular más allá de la última celda de la última fila (o pulsar Intro
en la última fila) añade una fila nueva en blanco automáticamente, para poder seguir rellenando la
tabla sin salir del teclado.

Fuera de edición, una celda muestra el texto con **negrita**/*cursiva*/~~tachado~~/`código`/
`==resaltado==` ya renderizados, igual que el resto de la nota; al hacer clic para editarla vuelve
a mostrar la sintaxis markdown en crudo, y al salir de la celda se renderiza de nuevo. Un `<br>`
dentro de una celda se muestra como un salto de línea real (la sintaxis de tabla no admite un salto
de línea literal dentro de una celda, así que esta es la forma estándar de conseguirlo). Un `|`
escapado como `\|` se trata como un carácter literal de la celda, nunca como separador de columna
— y se muestra como un `|` normal, sin el carácter de escape, tanto al editar como en la vista
renderizada. Una celda en blanco (en cualquier posición de la fila, incluida la última) se
reconoce correctamente y no descuadra el resto de la fila.

Un `[[wikilink]]` (o un enlace de tipo texto-más-URL entre corchetes y paréntesis, o una URL suelta) dentro de una celda se muestra
subrayado y en el color de enlace, y hacer clic sobre él navega/abre la URL igual que en cualquier
otro punto de la nota — antes se mostraba como texto plano sin formato dentro de las tablas.

Clic derecho sobre una celda abre un menú para añadir/eliminar la fila o columna bajo el cursor,
eliminar la tabla entera ("Eliminar tabla"), y copiar la tabla entera en un formato que
Excel/Outlook reconocen como tabla real (ver más abajo); clic derecho en cualquier otro punto del
editor ofrece crear una tabla nueva, o pegar el contenido del portapapeles como una tabla nueva.
Este menú propio sustituye al menú contextual nativo de VS Code dentro del editor (no hay forma de
añadir un ítem al menú nativo desde un webview), así que también incluye Cortar/Copiar/Pegar para
no perder esas opciones — los atajos de teclado (`Ctrl+C`/`X`/`V`) siguen funcionando igual que
siempre, esto es solo para cuando se usa el botón derecho. **El menú "Editar" nativo de la barra
superior de VS Code no funciona aquí** (ni para tablas ni para nada más dentro de este editor): sus
ítems invocan siempre comandos fijos pensados para un editor de texto normal, sin nada sobre lo que
actuar en este editor basado en webview — usa los atajos de teclado o el menú contextual propio
(clic derecho) en su lugar. No hay barra de herramientas para esto — es, igual que en Obsidian, el
único punto de entrada para gestionar filas y columnas.

Con el cursor dentro de una celda, copiar/cortar/pegar y cualquier atajo de teclado (incluido
`Ctrl+S` para pasar a modo fuente, o cualquier otro atajo de VS Code) funcionan con normalidad —
antes se bloqueaban silenciosamente mientras se estaba editando el contenido de una celda.

### Selección de varias celdas

Arrastrando el ratón desde una celda hasta otra (o hacienda Mayús+clic) se selecciona un rango
rectangular de celdas, igual que en una hoja de cálculo. Con el rango seleccionado, `Ctrl+C` copia
todas esas celdas de una vez (como texto separado por tabulaciones y como una tabla HTML real, para
pegar en Excel/Outlook/Sheets tal cual), `Ctrl+X` las corta (copia y además borra su contenido — o,
si la selección abarca la tabla entera, elimina la tabla entera, igual que "Eliminar tabla"), y
`Ctrl+V` pega el contenido del portapapeles empezando en la esquina superior izquierda del rango,
ampliando la tabla con filas/columnas nuevas si el contenido pegado no cabe. El menú contextual
propio (clic derecho) ofrece los mismos Cortar/Copiar para este rango, ya que el menú nativo de VS
Code no tiene forma de saber qué celdas están seleccionadas.

Con una selección así activa, el clic derecho sobre cualquier celda de ese rango cambia "Eliminar
fila"/"Eliminar columna" del menú contextual por "Eliminar filas"/"Eliminar columnas" — borra de una
vez todas las filas (o columnas) que abarca la selección, no solo la de la celda bajo el cursor. Un
clic derecho fuera de la selección activa, o con una sola celda seleccionada, muestra las opciones
en singular de siempre.

### Copiar/pegar como tabla (interoperabilidad con Excel/Outlook)

- **"Copiar como tabla"** (menú contextual de una tabla renderizada): copia la tabla completa al
  portapapeles en un formato que Excel/Outlook/Sheets reconocen como tabla real — al pegarlo ahí
  aparece como una cuadrícula de verdad, no como texto con los `|` visibles.
- **"Pegar como tabla"** (menú contextual fuera de una tabla): lee el portapapeles — si contiene
  una tabla copiada desde Excel/Outlook/Sheets (o cualquier otra tabla HTML), o simplemente texto
  separado por tabulaciones — y la inserta como una tabla markdown nueva en la posición del cursor.

## Dataview (` ```dataview ` / ` ```dql ` / ` ```dataviewjs `) — integración con "Obsidian-like Dataview"

Los bloques ` ```dataview `/` ```dql ` (consultas `LIST`/`TABLE`/`TASK`/`CALENDAR` al estilo del
plugin Dataview de Obsidian: `FROM`, `WHERE`, `SORT`, `GROUP BY`, `LIMIT`, `FLATTEN`) y
` ```dataviewjs ` (JavaScript con la API `dv.pages()`/`dv.table()`/`dv.list()`/`dv.taskList()`,
sandboxed) se renderizan directamente en el editor, igual que los bloques ` ```tasks `: enlaces a
notas clicables, tablas, listas y listados de tareas con checkbox.

Es también una **dependencia opcional**, esta vez de `angelCastro.obsidianlike-dataview`
(repo `obsidianlike_dataview`): si no está instalada, cada bloque muestra un aviso indicándolo en
vez de fallar en silencio o quedarse cargando indefinidamente. Toda la lógica (indexado del vault,
parser DQL, motor de consultas, sandbox de dataviewjs) vive en esa extensión — Obsidian-like solo
reenvía la consulta y pinta el HTML de resultado que le devuelve. A diferencia de la integración
con Tasks, los checkboxes de un bloque `TASK` son de solo lectura por ahora (no hay toggle
interactivo). Detalle técnico completo en `CLAUDE.md`.

### `dv.view(...)` — scripts DataviewJS interactivos con DOM real (Kanban/Eisenhower embebidos)

Un bloque ` ```dataviewjs ` cuyo código llama a `dv.view(nombre, input)` (la forma en que
Obsidian carga y ejecuta otro script del vault, p. ej. un `tasks-timeline.js`) **no** pasa por
`obsidianlike-dataview` — ese sandbox no tiene `dv.container` ni `app`, solo sirve para informes
de solo lectura (`dv.table`/`dv.list`). En su lugar, Obsidian-like busca ese fichero `.js` en
cualquier carpeta del vault, lo lee tal cual (sin modificarlo) y lo ejecuta con un `dv.container`
real (un `<div>` de verdad dentro del editor) y un `app` que imita `app.vault.read/modify`,
`app.workspace.getLeaf().openFile` y `app.metadataCache.getFirstLinkpathDest` — lo suficiente
para que scripts que manipulan DOM directamente (arrastrar y soltar, filtros, zoom, un Kanban o
una matriz Eisenhower de tareas completos) funcionen exactamente igual que en Obsidian, sin tocar
una sola línea del script original. Incluye también un polyfill de las extensiones que Obsidian
añade a `HTMLElement.prototype` y esos scripts dan por hechas (`createDiv`, `createEl`,
`createSpan`, `appendText`, `empty`, `addClass`/`removeClass`/`toggleClass`...).

`app.workspace.getLeaf().openFile(file, {eState:{line}})` (la forma con la que un script como
`tasks-timeline.js` abre la nota de una tarea desde su propia tarjeta) abre esa nota en una
pestaña nueva y, además de hacer scroll hasta esa línea, selecciona todo su texto — igual que al
hacer clic en el backlink de una fila de una consulta ` ```tasks ` — para que la tarea concreta
quede inmediatamente visible y lista para editarse o copiarse. `view` sigue devuelto como
`undefined` en el leaf que entrega `getLeaf()` (el editor real de VS Code no expone una instancia
CM6 al proceso de la extensión), así que cualquier manipulación que el script intente sobre
`view.editor` tras abrir el fichero no hace nada, silenciosamente — el posicionamiento/selección
ya ha ocurrido igualmente a través de este mecanismo.

Solo se detecta este caso cuando el bloque contiene literalmente `dv.view(` — cualquier otro
bloque `dataviewjs` (uno que solo use `dv.table()`/`dv.list()` para un informe simple) sigue
yendo por la ruta de `obsidianlike-dataview` de arriba, sin cambios. Detalle técnico completo en
`CLAUDE.md`.

### Ordenar y filtrar una tabla `dataview` al estilo Excel

Cualquier tabla renderizada por un bloque ` ```dataview `/` ```dql ` (`TABLE ...`) se puede
ordenar y filtrar directamente en el editor, sin tocar la consulta:

- **Ordenar**: clic en el texto de una columna para ordenar ascendente, otro clic para
  descendente, un tercero para volver al orden original. Detecta números automáticamente (`2`
  antes que `10`, no alfabéticamente).
- **Filtrar**: el botón `▾` junto a cada columna abre un desplegable con un buscador y una
  casilla por cada valor distinto de esa columna (con "Seleccionar todo") — igual que el
  autofiltro de Excel/Google Sheets, incluyendo que la lista de valores de una columna se
  actualiza según los filtros ya aplicados en las demás.

Es puramente visual: no cambia ni vuelve a ejecutar la consulta DQL, así que es instantáneo y
funciona igual sin conexión con `obsidianlike-dataview`. Al llegar un resultado nuevo (la nota
cambió, u otra nota del vault que afecta a la consulta) el orden/filtro se reinicia — no se
intenta reaplicar sobre datos distintos.

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
