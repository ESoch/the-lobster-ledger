# Third-party notices

The project MIT License in the root `LICENSE` file covers original Lobster Ledger software and documentation. The components and data below come from their respective projects and publishers.

## Web application

The build generates `dist/THIRD_PARTY_LICENSES.md` from the installed dependencies bundled in the web app. It includes the full notices for Fraunces and Manrope (SIL Open Font License 1.1), Lucide (ISC, with MIT notices for Feather-derived icons), and Leaflet (BSD 2-Clause). Keep this file and this supplementary notice with redistributed web builds.

The LL project icon in `public/favicon.svg` uses the uppercase L outline from the Latin 700-weight Fraunces font in the locked `@fontsource/fraunces` package. Its SIL Open Font License is included in the browser license file. The 180-pixel Apple touch icon is rendered from the same SVG on a solid project-color background.

To reproduce the touch icon from the repository root:

```sh
uv run --no-project --with resvg-py==0.5.0 python - <<'ICON'
from pathlib import Path
from resvg_py import svg_to_bytes

icon = svg_to_bytes(svg_path="public/favicon.svg", width=180, height=180, background="#162627")
Path("public/apple-touch-icon.png").write_bytes(icon)
ICON
```

The map requests tiles from OpenStreetMap at runtime. Map data is © OpenStreetMap contributors under the Open Database License. The map shows attribution. Preserve it and follow the tile usage policy when self-hosting. [OpenStreetMap copyright](https://www.openstreetmap.org/copyright) · [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/)

## Maine lobster landings data

The market chart displays published numerical observations from Maine Department of Marine Resources commercial landings data. See the original table and historical landings page for the source and methodology. The source PDF has no verified redistribution grant for this project. Obtain it from Maine DMR for an independent refresh. [Historical landings data](https://www.maine.gov/dmr/fisheries/commercial/landings-program/historical-data) · [Source table](https://www.maine.gov/dmr/sites/maine.gov.dmr/files/inline-files/lobster_table.pdf)

## CLI and server dependencies

The CLI archive includes the full Zod license in `THIRD_PARTY_NOTICES.txt`. The package manager installs `@napi-rs/keyring` separately under its own license. Server dependencies are installed from the lockfile under their package licenses. The Model Context Protocol server package describes its ongoing transition from MIT to Apache-2.0 in its license file.

## Supplementary browser dependency notice

The published `react-remove-scroll-bar@2.3.8` package declares MIT but omits the license text. The full current notice from its upstream project follows. [Upstream license](https://github.com/theKashey/react-remove-scroll-bar/blob/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE)

```text
MIT License

Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```
