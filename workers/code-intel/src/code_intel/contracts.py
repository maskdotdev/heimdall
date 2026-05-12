from contract_types import ChangeRequest, Diff, Repository


def imported_contract_names() -> tuple[str, str, str]:
    return Repository.__name__, ChangeRequest.__name__, Diff.__name__
