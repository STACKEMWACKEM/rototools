# Mask and timeline contract (schema 1)

Alpha is straight coverage in [0,1]. Empty projects/layers keep nothing. Hidden
layers contribute nothing; locked layers still render. Shapes and strokes combine
in order: replace B, add max(A,B), subtract A*(1-B), intersect A*B. Each layer then
applies square-neighborhood expansion/contraction in source pixels, separable
Gaussian feather (sigma in source pixels, radius ceil(3*sigma), zero boundary),
inversion, opacity. Layers combine with their named operation; the first layer is
also evaluated against zero. Model masks are a layer base, followed by authored
shapes/strokes. Protected manual corrections therefore survive model reruns.

Geometry stores stable point IDs, normalized anchors and optional absolute
normalized Bézier handles. Paths close from the last anchor to the first; cubic
segments use 16 subdivisions. Rasterization evaluates pixel centers. Brush radius
is in canonical source pixels, softness is the linear radial falloff fraction,
strength is alpha. Polyline segments join with round coverage. Transforms scale
about (0.5,0.5), rotate in the canonical source's pixel metric (so portrait aspect
ratio does not skew rotation), then translate in normalized source units.

Keyframes include whole editable layer state. Compatible ID/topology geometry
and numeric settings interpolate linearly or hold as selected on the left key.
Changed topology, stroke collections and model masks hold. Exact keys are never
modified by interpolation. The UI explains this policy. Current frame edits write
a keyframe. Protected frames are independent constraints on model propagation.

Output frame k is at k/30 seconds in the editing representation. Source mapping
uses the nearest preceding presented sample after source start normalization.
Online preparation uses FFmpeg fps=30 with round=up and records actual original
PTS/time base. Preview dimensions do not affect stored source units. Alpha PNGs
and ProRes are straight RGBA; opaque composites are computed in linear sRGB and
encoded as SDR. Checkerboard, handles, cursors and prompts are never exported.
