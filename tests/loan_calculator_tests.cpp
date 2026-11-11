#include "dfi/loan/loan_calculator.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

using dfi::loan::LoanInput;
using dfi::loan::LoanCalculator;

namespace {
int passed = 0;
int failed = 0;

void check(bool condition, const char* name)
{
    if (condition) { ++passed; std::cout << "[PASS] " << name << "\n"; }
    else { ++failed; std::cout << "[FAIL] " << name << "\n"; }
}

bool closeTo(long double actual, long double expected)
{
    return std::fabs(actual - expected) < 0.01L;
}
}

int main()
{
    const auto result = LoanCalculator::calculate({5000000.0L, 8.5L, 240});
    check(closeTo(result.monthlyEmi, 43391.161668L), "50 lakh at 8.5 percent for 20 years");
    check(closeTo(result.totalRepayment, result.monthlyEmi * 240.0L), "Total repayment");
    check(closeTo(result.totalInterest, result.totalRepayment - 5000000.0L), "Total interest");

    const auto zeroRate = LoanCalculator::calculate({120000.0L, 0.0L, 12});
    check(closeTo(zeroRate.monthlyEmi, 10000.0L), "Zero interest EMI");
    check(closeTo(zeroRate.totalInterest, 0.0L), "Zero interest total interest");

    bool rejected = false;
    try { LoanCalculator::calculate({-1000.0L, 8.0L, 120}); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "Reject negative principal");

    rejected = false;
    try { LoanCalculator::calculate({100000.0L, -1.0L, 120}); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "Reject negative interest rate");

    rejected = false;
    try { LoanCalculator::calculate({100000.0L, 8.0L, 0}); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "Reject zero tenure");

    rejected = false;
    try { LoanCalculator::calculate({100000.0L, 8.0L, 601}); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "Reject tenure above 600 months");

    rejected = false;
    try { LoanCalculator::calculate({std::numeric_limits<long double>::infinity(), 8.0L, 120}); }
    catch (const std::invalid_argument&) { rejected = true; }
    check(rejected, "Reject infinite principal");

    std::cout << "\nTests passed: " << passed << ", failed: " << failed << "\n";
    return failed == 0 ? 0 : 1;
}
