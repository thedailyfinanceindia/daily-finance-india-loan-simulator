#pragma once

#include "dfi/loan/loan_calculator.hpp"

#include <optional>
#include <vector>

namespace dfi::loan {

struct LoanSnapshot {
    long double outstandingBalance;
    long double annualInterestRate;
    long double currentEmi;
    unsigned int remainingTenureMonths;
};

struct PrepaymentEvent {
    unsigned int installmentNumber;
    long double amount;
};

enum class ProjectionStatus {
    Completed,
    NonAmortizing,
    TermExhausted,
    MaximumTenureExceeded
};

struct MonthlyProjection {
    unsigned int installmentNumber;
    long double annualInterestRate;
    long double openingBalance;
    long double interest;
    long double scheduledEmi;
    long double regularPayment;
    long double regularPrincipal;
    long double requestedPrepayment;
    long double prepaymentApplied;
    long double closingBalance;
};

struct LoanProjection {
    ProjectionStatus status{ProjectionStatus::Completed};
    unsigned int installments{};
    long double initialEmi{};
    long double lastEmi{};
    long double endingBalance{};
    long double totalInterest{};
    long double totalRegularPayments{};
    long double totalPrepaymentsRequested{};
    long double totalPrepaymentsApplied{};
    std::vector<MonthlyProjection> schedule;

    long double totalRepayment() const noexcept;
};

struct RateRevisionSimulation {
    LoanProjection baseline;
    LoanProjection keepEmi;
    LoanProjection keepTenure;
    std::optional<int> keepEmiTermChangeMonths;
    std::optional<long double> keepEmiInterestChange;
    std::optional<long double> keepTenureEmiChange;
    std::optional<long double> keepTenureInterestChange;
};

struct PrepaymentSimulation {
    LoanProjection baseline;
    LoanProjection reduceTenure;
    LoanProjection reduceEmi;
    std::optional<int> reduceTenureInstallmentsSaved;
    std::optional<long double> reduceTenureInterestSaved;
    std::optional<int> reduceEmiInstallmentsSaved;
    std::optional<long double> reduceEmiInterestSaved;
};

class LoanAmortizationSimulator {
public:
    static RateRevisionSimulation simulateRateRevision(
        const LoanSnapshot& loan,
        long double revisedAnnualInterestRate
    );

    static PrepaymentSimulation simulatePrepayments(
        const LoanSnapshot& loan,
        const std::vector<PrepaymentEvent>& events
    );
};

const char* projectionStatusName(ProjectionStatus status) noexcept;

} // namespace dfi::loan
