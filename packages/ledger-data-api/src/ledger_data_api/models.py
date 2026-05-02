"""Plain data models for the planner's persistence layer."""

from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class Plan:
    id: str
    date: str
    account: str
    amount: str
    description: str
    state: Optional[str]
    transferId: Optional[str]
    createdAt: str
    updatedAt: str
    # CC override tags. Set by the CC allocation dialog so the merge step can
    # recognize the plan as part of a (card, cycle) override set and suppress
    # the corresponding projection.
    ccCardRef: Optional[str] = None
    ccCycleMonth: Optional[str] = None  # "YYYY-MM"

    @classmethod
    def from_dict(cls, d: dict) -> "Plan":
        return cls(
            id=d["id"],
            date=d["date"],
            account=d["account"],
            amount=d.get("amount", ""),
            description=d.get("description", ""),
            state=d.get("state"),
            transferId=d.get("transferId"),
            createdAt=d.get("createdAt", ""),
            updatedAt=d.get("updatedAt", ""),
            ccCardRef=d.get("ccCardRef"),
            ccCycleMonth=d.get("ccCycleMonth"),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Transfer:
    id: str
    date: str
    fromAccount: str
    toAccount: str
    amount: str
    description: str
    state: Optional[str]
    createdAt: str
    updatedAt: str

    @classmethod
    def from_dict(cls, d: dict) -> "Transfer":
        return cls(
            id=d["id"],
            date=d["date"],
            fromAccount=d["fromAccount"],
            toAccount=d["toAccount"],
            amount=d.get("amount", ""),
            description=d.get("description", ""),
            state=d.get("state"),
            createdAt=d.get("createdAt", ""),
            updatedAt=d.get("updatedAt", ""),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CCCardRecord:
    accountPath: str
    fundingAccount: Optional[str] = None  # single default funding bank for this card
    statementCloseDay: Optional[int] = None
    paymentDueDay: Optional[int] = None
    statementBalance: Optional[str] = None
    lastClosedDate: Optional[str] = None
    minimumPaymentOnly: Optional[bool] = None
    updatedAt: Optional[str] = None

    @classmethod
    def from_dict(cls, account_path: str, d: dict) -> "CCCardRecord":
        return cls(
            accountPath=account_path,
            fundingAccount=d.get("fundingAccount"),
            statementCloseDay=d.get("statementCloseDay"),
            paymentDueDay=d.get("paymentDueDay"),
            statementBalance=d.get("statementBalance"),
            lastClosedDate=d.get("lastClosedDate"),
            minimumPaymentOnly=d.get("minimumPaymentOnly"),
            updatedAt=d.get("updatedAt"),
        )

    def to_storage_dict(self) -> dict:
        out: dict = {}
        for k, v in asdict(self).items():
            if k == "accountPath" or v is None:
                continue
            out[k] = v
        return out


@dataclass
class PlanSettings:
    bankFloor: str = "0.00"
    bankPanel: dict = field(
        default_factory=lambda: {
            "bankOrder": [],
            "hiddenBanks": [],
            "excludedFromTotalBanks": [],
        }
    )

    @classmethod
    def from_dict(cls, d: dict) -> "PlanSettings":
        return cls(
            bankFloor=d.get("bankFloor", "0.00"),
            bankPanel=d.get(
                "bankPanel",
                {"bankOrder": [], "hiddenBanks": [], "excludedFromTotalBanks": []},
            ),
        )

    def to_dict(self) -> dict:
        return asdict(self)
