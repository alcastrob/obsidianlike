# Vault Tool — extensión local de VS Code / Windsurf

Extensión de VS Code / Windsurf que actúa como vault local tipo Obsidian.
Se instala localmente desde un `.vsix`, sin marketplace ni servidores externos.

## Siguientes pasos sugeridos

- Sustituir el listado simple de notas por lectura real de frontmatter
  (puedes usar `gray-matter` vía npm, ya que no requiere red en tiempo de
  ejecución, solo en tiempo de instalación de dependencias).
- Portar la lógica de tu sistema Kanban/Eisenhower (HTML/JS/CSS que ya
  tienes) dentro de `getHtmlContent()` del webview, sustituyendo el
  placeholder actual.
- Añadir un motor de queries tipo Dataview que recorra el vault y genere
  tablas/listas a partir del frontmatter.

## Tareas pendientes

- [ ] Escribir un wikilink `[[` con sugerencias — al escribir `[[` en el
  editor, mostrar un desplegable con los nombres de las notas del vault para
  autocompletar el enlace.
- [ ] Wikilinks que apuntan a páginas inexistentes — distinguir visualmente
  un `[[enlace]]` roto (la nota destino no existe aún) de uno válido.
- [ ] Color diferente y navegación según estado del wikilink — los enlaces
  válidos se muestran en un color y al pulsarlos abren la nota destino; los
  enlaces rotos se muestran en otro color (p. ej. rojo o gris).
- [ ] Negritas y cursivas — renderizado y edición inline de `**negrita**` e
  `*cursiva*`.
- [ ] Listas numeradas y viñetas — soporte de `1.` y `-`/`*` con indentación
  anidada.
- [ ] Cabeceras — renderizado de `#`, `##`, `###`, etc. con tamaños distintos.
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
- [ ] Renombrar ficheros `.md` actualiza los enlaces — igual que mover, al
  renombrar una nota desde el explorador de VS Code, reescribir los
  `[[wikilinks]]` que la referenciaban en el resto del vault.
- [ ] Tablas — soporte de tablas Markdown (`| col | col |`) con renderizado
  visual y edición inline.
- [ ] Conmutar entre vista WYSIWYG y fuente — botón o atajo de teclado para
  alternar entre el editor de fuente Markdown y la vista renderizada (live
  preview).
- [ ] Transclusiones — soporte de `![[nota]]` para incrustar el contenido de
  otra nota (o un bloque concreto) dentro de la nota actual.
- [ ] Título editable como nombre de fichero — mostrar el nombre del fichero
  `.md` como título en la parte superior del área de texto; al editarlo
  directamente, renombrar el fichero en disco (y disparar la actualización
  de enlaces del resto del vault).
