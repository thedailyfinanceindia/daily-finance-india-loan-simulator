#pragma once

namespace dfi::loan {
inline constexpr unsigned int MAX_TENURE_MONTHS = 600;
inline constexpr long double MAX_ANNUAL_INTEREST_RATE = 100.0L;

struct LoanInput {
    long double principal;
    long double annualInterestRate;
    unsigned int tenureMonths;
};

struct LoanResult {
    long double monthlyEmi;
    long double totalInterest;
    long double totalRepayment;
};

class LoanCalculator {
public:
    static LoanResult calculate(const LoanInput& input);
};
}
