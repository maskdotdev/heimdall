"""Generated JSON serde helpers for Heimdall contract dataclasses."""

from __future__ import annotations

from dataclasses import MISSING, fields, is_dataclass
from types import NoneType, UnionType
from typing import Any, Literal, get_args, get_origin, get_type_hints

from .types import (
    ChangeRequest,
    ChangeRef,
    CodeGraph,
    LanguageSummary,
    SymbolRef,
    Symbol,
    DependencyEdge,
    RelatedTest,
    Actor,
    SourceLocation,
    TextRange,
    ArtifactRef,
    RedactionSummary,
    ContextBundle,
    SourceSnippet,
    FrontierItem,
    RelatedTestRef,
    PriorReviewComment,
    ScannerSignal,
    ContextLimits,
    Diff,
    DiffSummary,
    ChangedFile,
    DiffHunk,
    DiffLine,
    ReviewEvent,
    ReviewRunPayload,
    PhaseChangedPayload,
    ContextBundlePayload,
    ScannerCompletedPayload,
    FindingsValidatedPayload,
    PublishPayload,
    ErrorPayload,
    Finding,
    FindingEvidence,
    FixSuggestion,
    FindingValidation,
    ReviewerOutput,
    ReviewerFinding,
    ReviewerEvidence,
    ModelMetadata,
    ProviderReferences,
    ProviderRepositoryRef,
    ProviderChangeRequestRef,
    ProviderCommentRef,
    PublishableReview,
    PublishableComment,
    PublishApproval,
    Repository,
    ReviewRun,
    FindingsSummary,
    ReviewRunError,
    ReviewStandard,
    ReviewStandardScope,
    ReviewRule,
)


TYPE_BY_NAME: dict[str, type] = {
    'ChangeRequest': ChangeRequest,
    'ChangeRef': ChangeRef,
    'CodeGraph': CodeGraph,
    'LanguageSummary': LanguageSummary,
    'SymbolRef': SymbolRef,
    'Symbol': Symbol,
    'DependencyEdge': DependencyEdge,
    'RelatedTest': RelatedTest,
    'Actor': Actor,
    'SourceLocation': SourceLocation,
    'TextRange': TextRange,
    'ArtifactRef': ArtifactRef,
    'RedactionSummary': RedactionSummary,
    'ContextBundle': ContextBundle,
    'SourceSnippet': SourceSnippet,
    'FrontierItem': FrontierItem,
    'RelatedTestRef': RelatedTestRef,
    'PriorReviewComment': PriorReviewComment,
    'ScannerSignal': ScannerSignal,
    'ContextLimits': ContextLimits,
    'Diff': Diff,
    'DiffSummary': DiffSummary,
    'ChangedFile': ChangedFile,
    'DiffHunk': DiffHunk,
    'DiffLine': DiffLine,
    'ReviewEvent': ReviewEvent,
    'ReviewRunPayload': ReviewRunPayload,
    'PhaseChangedPayload': PhaseChangedPayload,
    'ContextBundlePayload': ContextBundlePayload,
    'ScannerCompletedPayload': ScannerCompletedPayload,
    'FindingsValidatedPayload': FindingsValidatedPayload,
    'PublishPayload': PublishPayload,
    'ErrorPayload': ErrorPayload,
    'Finding': Finding,
    'FindingEvidence': FindingEvidence,
    'FixSuggestion': FixSuggestion,
    'FindingValidation': FindingValidation,
    'ReviewerOutput': ReviewerOutput,
    'ReviewerFinding': ReviewerFinding,
    'ReviewerEvidence': ReviewerEvidence,
    'ModelMetadata': ModelMetadata,
    'ProviderReferences': ProviderReferences,
    'ProviderRepositoryRef': ProviderRepositoryRef,
    'ProviderChangeRequestRef': ProviderChangeRequestRef,
    'ProviderCommentRef': ProviderCommentRef,
    'PublishableReview': PublishableReview,
    'PublishableComment': PublishableComment,
    'PublishApproval': PublishApproval,
    'Repository': Repository,
    'ReviewRun': ReviewRun,
    'FindingsSummary': FindingsSummary,
    'ReviewRunError': ReviewRunError,
    'ReviewStandard': ReviewStandard,
    'ReviewStandardScope': ReviewStandardScope,
    'ReviewRule': ReviewRule,
}


def to_jsonable(value: Any) -> Any:
    if is_dataclass(value):
        result: dict[str, Any] = {}
        for field in fields(value):
            nested = getattr(value, field.name)
            if nested is None:
                continue
            json_name = field.metadata.get("json_name", field.name)
            result[json_name] = to_jsonable(nested)
        return result
    if isinstance(value, list | tuple):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: to_jsonable(nested) for key, nested in value.items()}
    return value


def from_json(contract_type: type | str, value: Any) -> Any:
    target_type = TYPE_BY_NAME[contract_type] if isinstance(contract_type, str) else contract_type
    return _from_json(target_type, value)


def _from_json(target_type: Any, value: Any) -> Any:
    if value is None:
        return None
    if target_type is Any:
        return value

    origin = get_origin(target_type)
    if origin is Literal:
        return value
    if origin is list:
        item_type = get_args(target_type)[0] if get_args(target_type) else Any
        return [_from_json(item_type, item) for item in value]
    if origin is dict:
        value_type = get_args(target_type)[1] if len(get_args(target_type)) == 2 else Any
        return {key: _from_json(value_type, item) for key, item in value.items()}
    if origin is UnionType or origin is getattr(__import__("typing"), "Union"):
        return _from_union(target_type, value)

    if isinstance(target_type, type) and is_dataclass(target_type):
        return _from_dataclass(target_type, value)

    return value


def _from_union(target_type: Any, value: Any) -> Any:
    args = get_args(target_type)
    if value is None and NoneType in args:
        return None

    errors: list[Exception] = []
    for item_type in args:
        if item_type is NoneType:
            continue
        try:
            return _from_json(item_type, value)
        except (KeyError, TypeError, ValueError) as error:
            errors.append(error)
    if errors:
        raise ValueError(f"could not decode value as {target_type!r}") from errors[0]
    return value


def _from_dataclass(target_type: type, value: Any) -> Any:
    if not isinstance(value, dict):
        raise TypeError(f"expected object for {target_type.__name__}")

    type_hints = get_type_hints(target_type)
    kwargs: dict[str, Any] = {}
    for field in fields(target_type):
        json_name = field.metadata.get("json_name", field.name)
        if json_name in value:
            kwargs[field.name] = _from_json(type_hints.get(field.name, Any), value[json_name])
        elif field.default is MISSING and field.default_factory is MISSING:
            raise KeyError(json_name)
    return target_type(**kwargs)
