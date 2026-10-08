from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Point(Strict):
    id: str = Field(max_length=80)
    x: float = Field(ge=-4, le=5)
    y: float = Field(ge=-4, le=5)
    in_: tuple[float, float] | None = Field(default=None, alias="in")
    out: tuple[float, float] | None = None


class Shape(Strict):
    id: str = Field(max_length=80)
    kind: Literal["rectangle", "ellipse", "polygon", "pen", "lasso", "brush"]
    op: Literal["add", "subtract", "intersect", "replace"] = "add"
    points: list[Point] = Field(max_length=2048)
    radius: float = Field(default=20, gt=0, le=512)
    softness: float = Field(default=0, ge=0, le=1)
    strength: float = Field(default=1, ge=0, le=1)


class State(Strict):
    shapes: list[Shape] = Field(default_factory=list, max_length=128)
    x: float = Field(default=0, ge=-4, le=4)
    y: float = Field(default=0, ge=-4, le=4)
    sx: float = Field(default=1, ge=0.01, le=10)
    sy: float = Field(default=1, ge=0.01, le=10)
    rotation: float = Field(default=0, ge=-3600, le=3600)
    opacity: float = Field(default=1, ge=0, le=1)
    feather: float = Field(default=0, ge=0, le=64)
    expansion: float = Field(default=0, ge=-64, le=64)
    invert: bool = False


class Key(Strict):
    frame: int = Field(ge=0, le=1800)
    interpolation: Literal["hold", "linear"] = "linear"
    state: State


class PromptPoint(Strict):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    label: Literal[0, 1]


class Prompt(Strict):
    frame: int = Field(ge=0, le=1800)
    points: list[PromptPoint] = Field(default_factory=list, max_length=64)
    box: tuple[float, float, float, float] | None = None

    @model_validator(mode="after")
    def box_valid(self):
        if self.box and (
            not all(0 <= x <= 1 for x in self.box)
            or self.box[0] >= self.box[2]
            or self.box[1] >= self.box[3]
        ):
            raise ValueError("Invalid selection box")
        return self


class ModelOutput(Strict):
    revision: int = Field(ge=0)
    provider: str = Field(max_length=100)
    checkpoint: str = Field(max_length=200)
    frames: dict[str, str] = Field(default_factory=dict)


class Layer(Strict):
    id: str = Field(max_length=80)
    name: str = Field(max_length=120)
    visible: bool = True
    locked: bool = False
    op: Literal["add", "subtract", "intersect", "replace"] = "add"
    keys: list[Key] = Field(min_length=1, max_length=1801)
    protected: list[int] = Field(default_factory=list, max_length=1801)
    prompts: list[Prompt] = Field(default_factory=list, max_length=128)
    model: ModelOutput | None = None

    @model_validator(mode="after")
    def unique_keys(self):
        if len({k.frame for k in self.keys}) != len(self.keys):
            raise ValueError("Duplicate keyframe")
        return self


class Frame(Strict):
    index: int = Field(ge=0)
    timestamp: float = Field(ge=0)
    sourceTimestamp: float
    sourcePts: int
    timeBase: str = Field(max_length=64)


class Source(Strict):
    id: str = Field(max_length=80)
    name: str = Field(max_length=250)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    size: int = Field(ge=1, le=268435456)
    width: int = Field(ge=1, le=4096)
    height: int = Field(ge=1, le=4096)
    duration: float = Field(gt=0, le=60)
    fps: Literal[30] = 30
    frames: list[Frame] = Field(min_length=1, max_length=1801)
    serverAsset: str | None = None
    metadata: dict | None = None


class Project(Strict):
    schema_: Literal[1] = Field(alias="schema")
    id: str = Field(max_length=80)
    name: str = Field(max_length=120)
    revision: int = Field(ge=0)
    created: int
    updated: int
    source: Source | None = None
    layers: list[Layer] = Field(max_length=16)
    inFrame: int = Field(ge=0)
    outFrame: int = Field(ge=0)
    mute: bool = False
    background: str = Field(default="#18212d", pattern=r"^#[0-9a-fA-F]{6}$")
    serverProject: str | None = None

    @model_validator(mode="after")
    def valid_frames(self):
        if len({l.id for l in self.layers}) != len(self.layers):
            raise ValueError("Duplicate layer")
        if self.source:
            count = len(self.source.frames)
            if self.inFrame > self.outFrame or self.outFrame >= count:
                raise ValueError("Invalid range")
            if any(
                f.index != i or abs(f.timestamp - i / 30) > 1e-5
                for i, f in enumerate(self.source.frames)
            ):
                raise ValueError("Invalid frame map")
            for l in self.layers:
                if (
                    any(k.frame >= count for k in l.keys)
                    or any(p.frame >= count for p in l.prompts)
                    or any(f < 0 or f >= count for f in l.protected)
                ):
                    raise ValueError("Frame outside source")
        return self


class ExportRequest(Strict):
    revision: int
    format: Literal["mp4", "matte", "png", "prores"]
    resolution: Literal["original", "720", "1080"] = "original"


class TrackRequest(Strict):
    revision: int
    layerId: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    anchor: int = Field(ge=0)
    direction: Literal["forward", "backward", "both", "frame"] = "forward"
