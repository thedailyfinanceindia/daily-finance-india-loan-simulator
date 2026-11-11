#include "dfi/loan/loan_comparison.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace dfi::loan;

int main()
{
    int failures = 0;
    const auto results = LoanComparisonEngine::compare(5000000.0L, 8.5L, {180, 240, 300});

    if (results.size() != 3) ++failures;
    if (!(results[0].result.monthlyEmi > results[1].result.monthlyEmi)) ++failures;
    if (!(results[1].result.monthlyEmi > results[2].result.monthlyEmi)) ++failures;
    if (!(results[0].result.totalInterest < results[1].result.totalInterest)) ++failures;
    if (!(results[1].result.totalInterest < results[2].result.totalInterest)) ++failures;

    bool rejected = false;
    try { LoanComparisonEngine::compare(5000000.0L, 8.5L, {}); }
    catch (const std::invalid_argument&) { rejected = true; }
    if (!rejected) ++failures;

    std::cout << "Comparison tests: " << (failures == 0 ? "PASSED" : "FAILED") << "\\n";
    return failures == 0 ? 0 : 1;
}
