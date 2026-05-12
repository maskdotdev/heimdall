from contract_types import Finding, ReviewerOutput


def imported_contract_names() -> tuple[str, str]:
    return ReviewerOutput.__name__, Finding.__name__
