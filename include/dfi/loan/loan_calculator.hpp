#pragma once

namespace dfi::loan {
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
