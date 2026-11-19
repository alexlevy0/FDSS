# Fièvres du Samedi Soir

A WebGL music visualization for the *Fièvres du Samedi Soir* mixes.

Each frequency bin of the track drives a node in a Delaunay mesh of springs;
the mesh is rendered to a texture, blurred, and used as a height/colour map
for an animated 3D grid, with motion blur and bloom on top.

Based on [audiofabric](https://github.com/rolyatmax/audiofabric) by Taylor Baldwin.

## Develop

```sh
npm install
npm run dev
```

## Build

```sh
npm run build    # outputs to dist/
npm run preview
```

Pushing to `master` deploys `dist/` to GitHub Pages through
`.github/workflows/deploy.yml` (Settings → Pages → Source: *GitHub Actions*).

## Structure

- `src/index.js` — setup, frequency mesh, render loop, tweak panel (lil-gui)
- `src/audio.js` — streamed `<audio>` + Web Audio analyser
- `src/title-card.js` — particle title screen
- `src/render-*.js` — grid, directional blur and bloom passes (regl)
- `public/` — audio mixes and fonts, copied as is
