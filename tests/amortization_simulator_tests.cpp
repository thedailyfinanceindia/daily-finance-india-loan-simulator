#include "dfi/loan/amortization_simulator.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace dfi::loan;

namespace {

int passed = 0;
int failed = 0;

void check(bool condition, const char* name)
{
    if (condition) {
        ++passed;
        std::cout << "[PASS] " << name << "\n";
    } else {
        ++failed;
        std::cout << "[FAIL] " << name << "\n";
    }
}

bool closeTo(long double actual, long double expected)
{
    return std::fabs(actual - expected) < 0.01L;
}

template<typename Callback>
bool throwsInvalidArgument(Callback callback)
{
    try {
        callback();
    } catch (const std::invalid_argument&) {
        return true;
    }
    return false;
}

} // namespace

int main()
{
    const LoanSnapshot loan{
        1000000.0L,
        10.0L,
        21247.04471126827444695120706917L,
        60
    };

    const auto rateChange =
        LoanAmortizationSimulator::simulateRateRevision(loan, 12.0L);

    check(
        rateChange.baseline.status == ProjectionStatus::Completed,
        "Current-rate baseline completes"
    );
    check(
        rateChange.baseline.installments == 60,
        "Current-rate baseline installment count"
    );
    check(
        closeTo(rateChange.baseline.totalInterest, 274822.682676096467L),
        "Independent baseline interest reference"
    );
    check(
        rateChange.baseline.installments == 60 &&
            rateChange.baseline.status == ProjectionStatus::Completed,
        "Baseline calculates payoff independently from contractual tenure"
    );
    check(
        closeTo(rateChange.baseline.schedule.front().openingBalance,
                loan.outstandingBalance) &&
            closeTo(rateChange.keepEmi.schedule.front().openingBalance,
                    loan.outstandingBalance) &&
            closeTo(rateChange.keepTenure.schedule.front().openingBalance,
                    loan.outstandingBalance),
        "All rate scenarios start from the same outstanding principal"
    );
    check(
        rateChange.keepEmi.status == ProjectionStatus::Completed &&
            rateChange.keepEmi.installments == 64,
        "Rate increase with the same EMI extends the term"
    );
    check(
        closeTo(rateChange.keepEmi.totalInterest, 358304.415549562216L),
        "Independent keep-EMI interest reference"
    );
    check(
        rateChange.keepEmiTermChangeMonths.has_value() &&
            *rateChange.keepEmiTermChangeMonths == 4,
        "Keep-EMI term change is signed against baseline payoff tenure"
    );
    check(
        rateChange.keepTenure.status == ProjectionStatus::Completed &&
            rateChange.keepTenure.installments == 60,
        "Keep-tenure simulation ends within the stated term"
    );
    check(
        closeTo(
            rateChange.keepTenure.initialEmi,
            22244.44768490177765L
        ),
        "Independent keep-tenure EMI reference"
    );
    check(
        closeTo(rateChange.keepTenure.totalInterest, 334666.861094106659L),
        "Independent keep-tenure interest reference"
    );

    const auto lowerRate =
        LoanAmortizationSimulator::simulateRateRevision(loan, 8.0L);
    check(
        lowerRate.keepEmi.status == ProjectionStatus::Completed &&
            lowerRate.keepEmi.installments < lowerRate.baseline.installments,
        "A lower rate shortens payoff with the same EMI"
    );
    check(
        lowerRate.keepEmi.totalInterest < lowerRate.baseline.totalInterest,
        "A lower rate reduces projected future interest"
    );

    const auto mismatchedRemainingTenure =
        LoanAmortizationSimulator::simulateRateRevision(
            {100000.0L, 0.0L, 5000.0L, 30},
            0.0L
        );
    check(
        mismatchedRemainingTenure.baseline.installments == 20 &&
            mismatchedRemainingTenure.keepEmiTermChangeMonths.has_value() &&
            *mismatchedRemainingTenure.keepEmiTermChangeMonths == 0,
        "Keep-EMI tenure change compares against baseline payoff duration"
    );

    const auto unchangedRate =
        LoanAmortizationSimulator::simulateRateRevision(loan, 10.0L);
    check(
        unchangedRate.keepEmi.installments ==
                unchangedRate.baseline.installments &&
            unchangedRate.keepEmiTermChangeMonths.has_value() &&
            *unchangedRate.keepEmiTermChangeMonths == 0 &&
            closeTo(
                unchangedRate.keepEmiInterestChange.value_or(-1.0L),
                0.0L
            ),
        "An unchanged rate matches the current baseline"
    );

    const std::vector<PrepaymentEvent> events{
        {12, 100000.0L},
        {24, 50000.0L}
    };
    const auto prepayments =
        LoanAmortizationSimulator::simulatePrepayments(loan, events);

    check(
        prepayments.reduceTenure.status == ProjectionStatus::Completed &&
            prepayments.reduceTenure.installments == 51,
        "Prepayments reduce the payoff term"
    );
    check(
        closeTo(
            prepayments.reduceTenure.totalInterest,
            216317.951111702799L
        ),
        "Independent reduce-tenure interest reference"
    );
    check(
        prepayments.reduceTenureInstallmentsSaved.has_value() &&
            *prepayments.reduceTenureInstallmentsSaved == 9,
        "Reduce-tenure installment savings"
    );
    check(
        closeTo(
            prepayments.reduceTenure.totalPrepaymentsApplied,
            150000.0L
        ),
        "Scheduled prepayments are applied after regular installments"
    );
    check(
        prepayments.reduceEmi.status == ProjectionStatus::Completed &&
            prepayments.reduceEmi.installments == 60,
        "Reduce-EMI keeps the stated payoff month"
    );
    check(
        closeTo(
            prepayments.reduceEmi.totalInterest,
            245001.345240402475L
        ),
        "Independent reduce-EMI interest reference"
    );
    check(
        prepayments.reduceEmiInterestSaved.has_value() &&
            closeTo(
                *prepayments.reduceEmiInterestSaved,
                29821.337435693992L
            ),
        "Reduce-EMI interest savings"
    );

    const auto cappedPrepayment =
        LoanAmortizationSimulator::simulatePrepayments(
            {100000.0L, 0.0L, 10000.0L, 10},
            {{1, 100000.0L}, {1, 100000.0L}}
        );
    check(
        cappedPrepayment.reduceTenure.installments == 1 &&
            closeTo(
                cappedPrepayment.reduceTenure.totalPrepaymentsRequested,
                200000.0L
            ) &&
            closeTo(
                cappedPrepayment.reduceTenure.totalPrepaymentsApplied,
                90000.0L
            ),
        "Duplicate prepayments aggregate and excess is capped at payoff"
    );
    check(
        closeTo(
            cappedPrepayment.reduceTenure.schedule[0].regularPayment,
            10000.0L
        ) &&
            closeTo(
                cappedPrepayment.reduceTenure.schedule[0].prepaymentApplied,
                90000.0L
            ),
        "Regular EMI is applied before the capped prepayment"
    );

    const auto nonAmortizing =
        LoanAmortizationSimulator::simulateRateRevision(
            {100000.0L, 12.0L, 1000.0L, 60},
            12.0L
        );
    check(
        nonAmortizing.baseline.status == ProjectionStatus::NonAmortizing &&
            !nonAmortizing.keepEmiInterestChange.has_value() &&
            !nonAmortizing.keepEmiTermChangeMonths.has_value(),
        "Non-amortizing baseline is explicit and has no interest delta"
    );

    const auto belowMonthlyInterest =
        LoanAmortizationSimulator::simulateRateRevision(
            {100000.0L, 12.0L, 999.0L, 60},
            12.0L
        );
    check(
        belowMonthlyInterest.baseline.status ==
            ProjectionStatus::NonAmortizing,
        "An EMI below monthly interest is non-amortizing"
    );

    const auto revisedRateNonAmortizing =
        LoanAmortizationSimulator::simulateRateRevision(
            {100000.0L, 0.0L, 500.0L, 600},
            12.0L
        );
    check(
            revisedRateNonAmortizing.baseline.status ==
                    ProjectionStatus::Completed &&
            revisedRateNonAmortizing.keepEmi.status ==
                ProjectionStatus::NonAmortizing &&
            !revisedRateNonAmortizing.keepEmiTermChangeMonths.has_value(),
        "A revised rate above the existing EMI's capacity has no payoff tenure"
    );

    const auto zeroInterest =
        LoanAmortizationSimulator::simulateRateRevision(
            {1000.0L, 0.0L, 300.0L, 4},
            0.0L
        );
    check(
        zeroInterest.baseline.status == ProjectionStatus::Completed &&
            zeroInterest.baseline.installments == 4 &&
            closeTo(zeroInterest.baseline.totalInterest, 0.0L) &&
            closeTo(zeroInterest.baseline.totalRepayment(), 1000.0L) &&
            closeTo(
                zeroInterest.baseline.schedule.back().regularPayment,
                100.0L
            ) &&
            zeroInterest.baseline.schedule.back().regularPayment <
                zeroInterest.baseline.initialEmi,
        "Zero-interest baseline includes a capped final installment"
    );

    const auto smallOutstanding =
        LoanAmortizationSimulator::simulateRateRevision(
            {0.01L, 0.0L, 1.0L, 1},
            0.0L
        );
    check(
        smallOutstanding.baseline.status == ProjectionStatus::Completed &&
            closeTo(
                smallOutstanding.baseline.schedule[0].regularPayment,
                0.01L
            ) &&
            closeTo(smallOutstanding.baseline.totalRepayment(), 0.01L),
        "A tiny balance is capped at the amount due"
    );

    const auto longTenure =
        LoanAmortizationSimulator::simulateRateRevision(
            {1000000.0L, 0.0L, 1000.0L, 600},
            0.0L
        );
    check(
        longTenure.baseline.status == ProjectionStatus::MaximumTenureExceeded &&
            longTenure.baseline.installments == 600 &&
            closeTo(longTenure.baseline.endingBalance, 400000.0L) &&
            longTenure.keepTenure.status == ProjectionStatus::Completed &&
            longTenure.keepTenure.installments == 600,
        "A 600-month remaining term is projected without overflow"
    );

    const auto exhaustedTerm =
        LoanAmortizationSimulator::simulatePrepayments(
            {100.0L, 0.0L, 1.0L, 1},
            {}
        );
    check(
        exhaustedTerm.reduceEmi.status == ProjectionStatus::TermExhausted,
        "Reduce-EMI reports an unpaid balance at the stated term"
    );

    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulatePrepayments(
                {100000.0L, 10.0L, 2000.0L, 12},
                {{13, 1000.0L}}
            );
        }),
        "Reject prepayment events outside the remaining term"
    );
    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulatePrepayments(
                {100000.0L, 10.0L, 2000.0L, 12},
                {{1, 0.0L}}
            );
        }),
        "Reject zero prepayment amounts"
    );
    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulateRateRevision(
                {100000.0L, 10.0L, 0.0L, 12},
                12.0L
            );
        }),
        "Reject a zero current EMI"
    );
    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulateRateRevision(
                {0.0L, 10.0L, 2000.0L, 12},
                12.0L
            );
        }),
        "Reject a non-positive outstanding balance"
    );
    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulateRateRevision(
                {100000.0L, -0.1L, 2000.0L, 12},
                12.0L
            );
        }),
        "Reject an invalid current interest rate"
    );
    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulateRateRevision(
                {100000.0L, 10.0L, 2000.0L, 0},
                12.0L
            );
        }),
        "Reject a non-positive remaining tenure"
    );
    check(
        throwsInvalidArgument([] {
            LoanAmortizationSimulator::simulateRateRevision(
                {100000.0L, 10.0L, 2000.0L, 12},
                100.1L
            );
        }),
        "Reject revised rates above the application limit"
    );

    std::cout << "\nTests passed: " << passed << ", failed: " << failed << "\n";
    return failed == 0 ? 0 : 1;
}
