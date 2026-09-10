#pragma once
#include "individual.h"
#include <cstdint>
#include <random>

namespace fcngraph {
struct GeneticOptions {
    std::uint64_t seed = 1;
    std::size_t generations = 100;
    std::size_t population = 64;
    double budget_seconds = 10;
};

// Bounded, reproducible adaptation of the original iFCN GA. Placement genes
// remain coordinates; the selected regular template is never mutated.
class GeneticAlgorithm {
public:
    GeneticAlgorithm(Parse& parse, GridChessboard& board, Astar& router, GeneticOptions options);
    bool gaRun();
    const Individual& best() const { return best_; }
    std::size_t evaluated() const { return evaluated_; }
    std::size_t feasible() const { return feasible_; }
    const std::string& lastError() const { return last_error_; }
private:
    Individual randomIndividual(std::size_t index);
    void repair(Individual& individual);
    void mutate(Individual& individual);
    Parse& parse_;
    GridChessboard& board_;
    Astar& router_;
    GeneticOptions options_;
    std::mt19937_64 rng_;
    std::vector<position> sites_;
    Individual best_;
    std::size_t evaluated_ = 0, feasible_ = 0;
    std::string last_error_;
};
}
