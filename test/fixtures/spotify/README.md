# Spotify fixtures

These are built from the response shapes in Spotify's Web API reference as
read on 2026-11-14 (after the February 2026 changes). They are not recordings:
nothing has been captured from a real Spotify account yet. When a real
response is captured, add it as `recorded-*.json` with IDs replaced.

- `doc-search-tracks.json`: `GET /search?type=track`. Includes fields the code
  ignores, and a non-track entry that must be skipped.
- `doc-playlist-items.json`: one page of `GET /playlists/{id}/items`. The track
  is under `item`; `track` is the deprecated name and is absent.
