"""Python port of normalizeOrg / nameSimilarity / sameOrg from src/lib/names.ts."""
import re, unicodedata

_NOISE = re.compile(
    r"\b("
    + "|".join(
        [
            "SEPARATE SEGREGATED FUND", "SSF",
            "POLITICAL ACTION COMMITTEE", "POLITICAL ACTION COMM", "POLITICAL ACTION",
            "POLITICAL FUND", "POLITICAL", "PAC", "FEDERAL", "GOOD GOVERNMENT FUND", "GOOD GOVERNMENT COMMITTEE",
            "EMPLOYEES?", "COMMITTEE", "FUND", "INCORPORATED", "INC", "CORPORATION",
            "CORP", "COMPANY", "COMPANIES", "CO", "LLC", "LLP", "LP", "LTD", "PLC",
            "PC", "PA", "NA", "HOLDINGS?", "GROUP", "THE", "AND AFFILIATES",
        ]
    )
    + r")\b"
)


def normalize_org(name: str) -> str:
    s = unicodedata.normalize("NFD", (name or "").upper())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"/[A-Z]{2,3}/?$", "", s)
    s = re.sub(r"['’]", "", s)
    s = s.replace("&", " AND ")
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"\s+A\.?\s?K\.?\s?A\.?\s.*$", "", s)
    s = re.sub(r"\bASSN\b", "ASSOCIATION", s)
    s = re.sub(r"\bNATL\b", "NATIONAL", s)
    s = re.sub(r"\bAMER\b", "AMERICAN", s)
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    s = re.sub(r"\b([A-Z]) (?=[A-Z]\b)", r"\1", s)
    s = _NOISE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(AND|OF) | (AND|OF)$", "", s)
    return s


def name_similarity(a: str, b: str) -> float:
    ta = set(normalize_org(a).split())
    tb = set(normalize_org(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def same_org(a: str, b: str) -> bool:
    na, nb = normalize_org(a), normalize_org(b)
    return bool(na) and (na == nb or name_similarity(a, b) >= 0.8)
