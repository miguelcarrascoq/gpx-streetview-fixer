# GPX Street View Fixer

Herramienta para **analizar y corregir** archivos `.gpx` (p. ej. exportados desde Insta360 Studio) antes de subirlos a [Google Street View Studio](https://streetviewstudio.maps.google.com/) junto al video 360.

## Qué corrige

1. **Bounds con signos incorrectos** — Insta360 a veces escribe lat/lon positivos en `<bounds>` mientras los trackpoints van en hemisferio sur/oeste (Chile, etc.).
2. **Sincronía con el video** — Si el archivo se llama `VID_YYYYMMDD_HHMMSS_…`, alinea el inicio del GPX a esa hora local (por defecto **America/Santiago = UTC−3**). Street View exige que el rango GPS se solape con el del MP4.
3. **1 punto por segundo** — Varios puntos con el mismo timestamp hacen que Google interprete saltos imposibles y rechace la secuencia.

## Uso rápido (CLI) — otros archivos

```bash
npm install

# Solo informe (no escribe archivo)
npm run analyze -- ./uploads/VID_20251117_054832_00_003.gpx

# Corregir → genera *_streetview.gpx al lado del original
npm run fix -- ./uploads/VID_20251117_054832_00_003.gpx

# Salida explícita
npm run fix -- ./mi-clip.gpx --out ./out/mi-clip_streetview.gpx

# Si la hora del MP4 no coincide con el nombre VID_*
npm run fix -- ./mi-clip.gpx --start 2025-11-17T08:48:32Z

# Otra zona (offset de la cámara respecto a UTC)
npm run fix -- ./mi-clip.gpx --offset -3
```

### Checklist para cada clip nuevo

1. Exporta el **MP4 360** y el **GPX** del mismo clip.
2. Conserva el prefijo `VID_YYYYMMDD_HHMMSS` en el `.gpx` (hora local de la cámara).
3. Ejecuta `npm run fix -- ruta/al/archivo.gpx`.
4. Revisa que el informe **Después** no tenga errores.
5. En Street View Studio: Upload del video → **More → Upload GPX file** → elige el `*_streetview.gpx`.

## App web

```bash
npm run dev
```

Abre http://127.0.0.1:43123 — arrastra un `.gpx`, revisa el informe y descarga el corregido.

## Archivo de este proyecto

| Archivo | Descripción |
|---------|-------------|
| [`uploads/VID_20251117_054832_00_003_f286.gpx`](uploads/VID_20251117_054832_00_003_f286.gpx) | Original Insta360 (bounds mal, ~10 Hz, fechas desfasadas) |
| [`output/VID_20251117_054832_00_003_streetview.gpx`](output/VID_20251117_054832_00_003_streetview.gpx) | Corregido listo para Street View |

### Decisiones aplicadas a este clip

- Bounds recalculados a lat/lon **negativos** (zona Temuco, Chile).
- Inicio alineado a `VID_20251117_054832` → `2025-11-17T08:48:32Z` (05:48:32 local UTC−3).
- Reducción de ~17 147 puntos a ~1 punto/s (~29 min de track).

Si al subir Street View dice que GPS y video no se solapan, lee la hora real del MP4 (Exif / Studio) y vuelve a correr con `--start <ISO-UTC>`.
