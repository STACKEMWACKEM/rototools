"""Pinned upstream model provenance, independent of any local download."""

SAM2_TINY = {
    "filename": "sam2.1_hiera_tiny.pt",
    "config": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "sha256": "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
    "bytes": 156008466,
    "repository": "facebook/sam2.1-hiera-tiny",
    "revision": "de431c4043854a71d8101e17995dfe596bf101a5",
}
SAM2_TINY["url"] = (
    "https://huggingface.co/"
    f"{SAM2_TINY['repository']}/resolve/{SAM2_TINY['revision']}/"
    f"{SAM2_TINY['filename']}"
)
