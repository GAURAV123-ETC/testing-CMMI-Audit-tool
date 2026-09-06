from io import BytesIO


def _ocr(image) -> str:
    try:
        import pytesseract
        return pytesseract.image_to_string(image)
    except ImportError:
        return '[OCR unavailable: install the Tesseract system package]'
    except Exception as exc:
        return f'[OCR error: {type(exc).__name__}]'


def ocr_image(path: str) -> str:
    """Extract text from an image file without letting OCR abort a scan."""
    try:
        from PIL import Image
        with Image.open(path) as image:
            return _ocr(image)
    except Exception as exc:
        return f'[OCR error: {type(exc).__name__}]'


def ocr_image_bytes(content: bytes) -> str:
    """OCR an in-memory rendered PDF page."""
    try:
        from PIL import Image
        with Image.open(BytesIO(content)) as image:
            return _ocr(image)
    except Exception as exc:
        return f'[OCR error: {type(exc).__name__}]'
