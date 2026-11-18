#include "dfi/loan/amortization_simulator.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <stdexcept>

namespace dfi::loan {
namespace {

constexpr long double BALANCE_EPSILON = 1e-7L;

using EventSchedule = std::map<unsigned int, long double>;

void validateRate(long double annualInterestRate)
{
    if (!std::isfinite(annualInterestRate) ||
        annualInterestRate < 0.0L ||
        annualInterestRate > MAX_ANNUAL_INTEREST_RATE) {
        throw std::invalid_argument(
            "Annual interest rate must be between 0 and 100 percent."
        );
    }
}

void validateLoan(const LoanSnapshot& loan)
{
    if (!std::isfinite(loan.outstandingBalance) ||
        loan.outstandingBalance <= 0.0L) {
        throw std::invalid_argument(
            "Outstanding balance must be positive and finite."
        );
    }

    validateRate(loan.annualInterestRate);

    if (!std::isfinite(loan.currentEmi) || loan.currentEmi <= 0.0L) {
        throw std::invalid_argument("Current EMI must be positive and finite.");
    }

    if (loan.remainingTenureMonths == 0 ||
        loan.remainingTenureMonths > MAX_TENURE_MONTHS) {
        throw std::invalid_argument(
            "Remaining tenure must be between 1 and 600 months."
        );
    }
}

EventSchedule makeEventSchedule(
    const LoanSnapshot& loan,
    const std::vector<PrepaymentEvent>& events,
    long double& totalRequested
)
{
    EventSchedule schedule;
    totalRequested = 0.0L;

    for (const auto& event : events) {
        if (event.installmentNumber == 0 ||
            event.installmentNumber > loan.remainingTenureMonths) {
            throw std::invalid_argument(
                "Each prepayment must target an installment within the remaining tenure."
            );
        }

        if (!std::isfinite(event.amount) || event.amount <= 0.0L) {
            throw std::invalid_argument(
                "Prepayment amounts must be positive and finite."
            );
        }

        auto& amountForInstallment = schedule[event.installmentNumber];
        amountForInstallment += event.amount;
        totalRequested += event.amount;

        if (!std::isfinite(amountForInstallment) ||
            !std::isfinite(totalRequested)) {
            throw std::overflow_error(
                "Prepayment schedule exceeded the supported numeric range."
            );
        }
    }

    return schedule;
}

LoanProjection project(
    long double outstandingBalance,
    long double annualInterestRate,
    long double currentEmi,
    unsigned int maximumInstallments,
    const EventSchedule& events,
    long double totalPrepaymentsRequested,
    bool recalculateEmiAfterPrepayment,
    bool fixedTerm
)
{
    LoanProjection result;
    result.initialEmi = currentEmi;
    result.lastEmi = currentEmi;
    result.endingBalance = outstandingBalance;
    result.totalPrepaymentsRequested = totalPrepaymentsRequested;
    result.schedule.reserve(maximumInstallments);

    const long double monthlyRate = annualInterestRate / 1200.0L;
    long double balance = outstandingBalance;
    long double scheduledEmi = currentEmi;

    for (unsigned int month = 1; month <= maximumInstallments; ++month) {
        const long double openingBalance = balance;
        const long double interest = openingBalance * monthlyRate;
        const long double amountDue = openingBalance + interest;

        if (!std::isfinite(interest) || !std::isfinite(amountDue)) {
            throw std::overflow_error(
                "Loan projection exceeded the supported numeric range."
            );
        }

        const long double regularPayment = std::min(scheduledEmi, amountDue);
        const long double regularPrincipal = regularPayment - interest;
        const long double balanceAfterRegularPayment =
            amountDue - regularPayment;

        const auto event = events.find(month);
        const long double requestedPrepayment =
            event == events.end() ? 0.0L : event->second;
        const long double prepaymentApplied =
            std::min(requestedPrepayment, balanceAfterRegularPayment);
        balance = balanceAfterRegularPayment - prepaymentApplied;

        if (balance <= BALANCE_EPSILON) {
            balance = 0.0L;
        }

        result.schedule.push_back({
            month,
            annualInterestRate,
            openingBalance,
            interest,
            scheduledEmi,
            regularPayment,
            regularPrincipal,
            requestedPrepayment,
            prepaymentApplied,
            balance
        });
        result.installments = month;
        result.endingBalance = balance;
        result.totalInterest += interest;
        result.totalRegularPayments += regularPayment;
        result.totalPrepaymentsApplied += prepaymentApplied;

        if (!std::isfinite(result.totalInterest) ||
            !std::isfinite(result.totalRegularPayments) ||
            !std::isfinite(result.totalPrepaymentsApplied)) {
            throw std::overflow_error(
                "Loan projection exceeded the supported numeric range."
            );
        }

        if (balance == 0.0L) {
            result.status = ProjectionStatus::Completed;
            return result;
        }

        if (recalculateEmiAfterPrepayment &&
            requestedPrepayment > 0.0L) {
            if (month == maximumInstallments) {
                result.status = ProjectionStatus::TermExhausted;
                return result;
            }

            const unsigned int remainingMonths = maximumInstallments - month;
            scheduledEmi = LoanCalculator::calculate({
                balance,
                annualInterestRate,
                remainingMonths
            }).monthlyEmi;
            result.lastEmi = scheduledEmi;
        }

        if (balance >= openingBalance &&
            events.upper_bound(month) == events.end()) {
            result.status = ProjectionStatus::NonAmortizing;
            return result;
        }
    }

    result.status = fixedTerm
        ? ProjectionStatus::TermExhausted
        : ProjectionStatus::MaximumTenureExceeded;
    return result;
}

void setInterestChange(
    const LoanProjection& baseline,
    const LoanProjection& projection,
    std::optional<long double>& change
)
{
    if (baseline.status == ProjectionStatus::Completed &&
        projection.status == ProjectionStatus::Completed) {
        change = projection.totalInterest - baseline.totalInterest;
    }
}

} // namespace

long double LoanProjection::totalRepayment() const noexcept
{
    return totalRegularPayments + totalPrepaymentsApplied;
}

RateRevisionSimulation LoanAmortizationSimulator::simulateRateRevision(
    const LoanSnapshot& loan,
    long double revisedAnnualInterestRate
)
{
    validateLoan(loan);
    validateRate(revisedAnnualInterestRate);

    const EventSchedule noEvents;
    RateRevisionSimulation result;
    result.baseline = project(
        loan.outstandingBalance,
        loan.annualInterestRate,
        loan.currentEmi,
        MAX_TENURE_MONTHS,
        noEvents,
        0.0L,
        false,
        false
    );
    result.keepEmi = project(
        loan.outstandingBalance,
        revisedAnnualInterestRate,
        loan.currentEmi,
        MAX_TENURE_MONTHS,
        noEvents,
        0.0L,
        false,
        false
    );

    const long double tenureEmi = LoanCalculator::calculate({
        loan.outstandingBalance,
        revisedAnnualInterestRate,
        loan.remainingTenureMonths
    }).monthlyEmi;
    result.keepTenure = project(
        loan.outstandingBalance,
        revisedAnnualInterestRate,
        tenureEmi,
        loan.remainingTenureMonths,
        noEvents,
        0.0L,
        false,
        true
    );

    if (result.baseline.status == ProjectionStatus::Completed &&
        result.keepEmi.status == ProjectionStatus::Completed) {
        result.keepEmiTermChangeMonths =
            static_cast<int>(result.keepEmi.installments) -
            static_cast<int>(result.baseline.installments);
    }
    setInterestChange(
        result.baseline,
        result.keepEmi,
        result.keepEmiInterestChange
    );

    if (result.keepTenure.status == ProjectionStatus::Completed) {
        result.keepTenureEmiChange =
            result.keepTenure.initialEmi - loan.currentEmi;
    }
    setInterestChange(
        result.baseline,
        result.keepTenure,
        result.keepTenureInterestChange
    );

    return result;
}

PrepaymentSimulation LoanAmortizationSimulator::simulatePrepayments(
    const LoanSnapshot& loan,
    const std::vector<PrepaymentEvent>& events
)
{
    validateLoan(loan);

    long double totalPrepaymentsRequested = 0.0L;
    const auto schedule = makeEventSchedule(
        loan,
        events,
        totalPrepaymentsRequested
    );

    PrepaymentSimulation result;
    result.baseline = project(
        loan.outstandingBalance,
        loan.annualInterestRate,
        loan.currentEmi,
        loan.remainingTenureMonths,
        {},
        0.0L,
        false,
        true
    );
    result.reduceTenure = project(
        loan.outstandingBalance,
        loan.annualInterestRate,
        loan.currentEmi,
        MAX_TENURE_MONTHS,
        schedule,
        totalPrepaymentsRequested,
        false,
        false
    );
    result.reduceEmi = project(
        loan.outstandingBalance,
        loan.annualInterestRate,
        loan.currentEmi,
        loan.remainingTenureMonths,
        schedule,
        totalPrepaymentsRequested,
        true,
        true
    );

    if (result.baseline.status == ProjectionStatus::Completed &&
        result.reduceTenure.status == ProjectionStatus::Completed) {
        result.reduceTenureInstallmentsSaved =
            static_cast<int>(result.baseline.installments) -
            static_cast<int>(result.reduceTenure.installments);
        result.reduceTenureInterestSaved =
            result.baseline.totalInterest -
            result.reduceTenure.totalInterest;
    }

    if (result.baseline.status == ProjectionStatus::Completed &&
        result.reduceEmi.status == ProjectionStatus::Completed) {
        result.reduceEmiInstallmentsSaved =
            static_cast<int>(result.baseline.installments) -
            static_cast<int>(result.reduceEmi.installments);
        result.reduceEmiInterestSaved =
            result.baseline.totalInterest -
            result.reduceEmi.totalInterest;
    }

    return result;
}

const char* projectionStatusName(ProjectionStatus status) noexcept
{
    switch (status) {
    case ProjectionStatus::Completed:
        return "completed";
    case ProjectionStatus::NonAmortizing:
        return "non_amortizing";
    case ProjectionStatus::TermExhausted:
        return "term_exhausted";
    case ProjectionStatus::MaximumTenureExceeded:
        return "maximum_tenure_exceeded";
    }

    return "unknown";
}

} // namespace dfi::loan
