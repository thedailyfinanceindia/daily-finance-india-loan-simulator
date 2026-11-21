
#include "dfi/loan/loan_calculator.hpp"
#include "dfi/loan/amortization_simulator.hpp"

#include <stdexcept>
#include <cmath>
#include <vector>

namespace {

double result_buffer[3] = {};
double rate_result_buffer[19] = {};
double prepayment_result_buffer[19] = {};
double prepayment_event_buffer[1200] = {};

unsigned int statusCode(dfi::loan::ProjectionStatus status) {
    switch (status) {
    case dfi::loan::ProjectionStatus::Completed: return 0;
    case dfi::loan::ProjectionStatus::NonAmortizing: return 1;
    case dfi::loan::ProjectionStatus::TermExhausted: return 2;
    case dfi::loan::ProjectionStatus::MaximumTenureExceeded: return 3;
    }
    return 4;
}

void writeProjection(double* target, unsigned int offset,
                     const dfi::loan::LoanProjection& projection) {
    target[offset] = statusCode(projection.status);
    target[offset + 1] = projection.installments;
    target[offset + 2] = static_cast<double>(projection.initialEmi);
    target[offset + 3] = static_cast<double>(projection.totalInterest);
    target[offset + 4] = static_cast<double>(projection.totalRepayment());
}

}

extern "C" {

// Return codes:
// 0 = success
// 1 = invalid input
// 2 = numeric overflow
// 3 = unexpected calculation error

int dfi_calculate_loan(
    double principal,
    double annual_interest_rate,
    unsigned int tenure_months
) noexcept {
    try {
        const dfi::loan::LoanInput input{
            static_cast<long double>(principal),
            static_cast<long double>(annual_interest_rate),
            tenure_months
        };

        const auto result = dfi::loan::LoanCalculator::calculate(input);

        result_buffer[0] = static_cast<double>(result.monthlyEmi);
        result_buffer[1] = static_cast<double>(result.totalInterest);
        result_buffer[2] = static_cast<double>(result.totalRepayment);

        return 0;
    }
    catch (const std::invalid_argument&) {
        return 1;
    }
    catch (const std::overflow_error&) {
        return 2;
    }
    catch (...) {
        return 3;
    }
}

double* dfi_get_result_ptr() noexcept {
    return result_buffer;
}

int dfi_simulate_rate_revision(
    double outstanding_balance,
    double current_rate,
    double current_emi,
    unsigned int remaining_tenure_months,
    double revised_rate
) noexcept {
    try {
        const dfi::loan::LoanSnapshot loan{
            static_cast<long double>(outstanding_balance),
            static_cast<long double>(current_rate),
            static_cast<long double>(current_emi),
            remaining_tenure_months
        };
        const auto simulation =
            dfi::loan::LoanAmortizationSimulator::simulateRateRevision(
                loan,
                static_cast<long double>(revised_rate)
            );

        writeProjection(rate_result_buffer, 0, simulation.baseline);
        writeProjection(rate_result_buffer, 5, simulation.keepEmi);
        writeProjection(rate_result_buffer, 10, simulation.keepTenure);
        rate_result_buffer[15] = simulation.keepEmiTermChangeMonths
            ? *simulation.keepEmiTermChangeMonths : NAN;
        rate_result_buffer[16] = simulation.keepEmiInterestChange
            ? static_cast<double>(*simulation.keepEmiInterestChange) : NAN;
        rate_result_buffer[17] = simulation.keepTenureEmiChange
            ? static_cast<double>(*simulation.keepTenureEmiChange) : NAN;
        rate_result_buffer[18] = simulation.keepTenureInterestChange
            ? static_cast<double>(*simulation.keepTenureInterestChange) : NAN;
        return 0;
    } catch (const std::invalid_argument&) {
        return 1;
    } catch (const std::overflow_error&) {
        return 2;
    } catch (...) {
        return 3;
    }
}

double* dfi_get_rate_result_ptr() noexcept {
    return rate_result_buffer;
}

int dfi_simulate_prepayments(
    double outstanding_balance,
    double current_rate,
    double current_emi,
    unsigned int remaining_tenure_months,
    unsigned int event_count
) noexcept {
    try {
        if (event_count > 600) return 1;
        std::vector<dfi::loan::PrepaymentEvent> events;
        events.reserve(event_count);
        for (unsigned int index = 0; index < event_count; ++index) {
            events.push_back({
                static_cast<unsigned int>(prepayment_event_buffer[index * 2]),
                static_cast<long double>(prepayment_event_buffer[index * 2 + 1])
            });
        }

        const dfi::loan::LoanSnapshot loan{
            static_cast<long double>(outstanding_balance),
            static_cast<long double>(current_rate),
            static_cast<long double>(current_emi),
            remaining_tenure_months
        };
        const auto simulation =
            dfi::loan::LoanAmortizationSimulator::simulatePrepayments(
                loan,
                events
            );

        writeProjection(prepayment_result_buffer, 0, simulation.baseline);
        writeProjection(prepayment_result_buffer, 5, simulation.reduceTenure);
        writeProjection(prepayment_result_buffer, 10, simulation.reduceEmi);
        prepayment_result_buffer[15] = simulation.reduceTenureInstallmentsSaved
            ? *simulation.reduceTenureInstallmentsSaved : NAN;
        prepayment_result_buffer[16] = simulation.reduceTenureInterestSaved
            ? static_cast<double>(*simulation.reduceTenureInterestSaved) : NAN;
        prepayment_result_buffer[17] = simulation.reduceEmiInstallmentsSaved
            ? *simulation.reduceEmiInstallmentsSaved : NAN;
        prepayment_result_buffer[18] = simulation.reduceEmiInterestSaved
            ? static_cast<double>(*simulation.reduceEmiInterestSaved) : NAN;
        return 0;
    } catch (const std::invalid_argument&) {
        return 1;
    } catch (const std::overflow_error&) {
        return 2;
    } catch (...) {
        return 3;
    }
}

double* dfi_get_prepayment_result_ptr() noexcept {
    return prepayment_result_buffer;
}

void dfi_set_prepayment_event(
    unsigned int index,
    unsigned int installment_number,
    double amount
) noexcept {
    if (index >= 600) return;
    prepayment_event_buffer[index * 2] = installment_number;
    prepayment_event_buffer[index * 2 + 1] = amount;
}

}
